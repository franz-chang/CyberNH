#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${CYBERNH_ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
DEFAULT_LLM_DIR="$(cd "$ROOT_DIR/.." && pwd)/$(basename "$ROOT_DIR")-LLM"
LLM_DIR="${CYBERNH_LLM_DIR:-$DEFAULT_LLM_DIR}"
export CYBERNH_LLM_DIR="$LLM_DIR"

LLM_LOG_DIR="$ROOT_DIR/runtime/logs"
LLM_LOG_FILE="$LLM_LOG_DIR/llm-serve.log"
LLM_PID_FILE="$ROOT_DIR/runtime/llm.pid"
LLM_READY_TIMEOUT_SECONDS="${CYBERNH_LLM_READY_TIMEOUT_SECONDS:-600}"

load_env_defaults() {
  local env_file="$1"
  local line key value
  [[ -f "$env_file" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == export\ * ]] && line="${line#export }"
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" == "$line" ]] && continue
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    if [[ ( "$value" == \"*\" && "$value" == *\" ) || ( "$value" == \'*\' && "$value" == *\' ) ]]; then
      value="${value:1:${#value}-2}"
    fi
    if [[ -z "${!key+x}" ]]; then
      export "$key=$value"
    fi
  done < "$env_file"
}

load_env_defaults "$LLM_DIR/.env"

BASE_URL="${CYBERNH_LLM_BASE_URL:-http://localhost:8000/v1}"
BASE_URL="${BASE_URL%/}"
MODEL_DIR="${CYBERNH_LLM_LOCAL_DIR:-$LLM_DIR/models/Qwen3-8B-Instruct}"
MODEL_NAME="${CYBERNH_LLM_MODEL:-qwen3-8b-instruct}"
API_KEY="${CYBERNH_LLM_API_KEY:-EMPTY}"
BACKGROUND="${CYBERNH_LLM_BACKGROUND:-0}"
CHAT="${CYBERNH_LLM_CHAT:-1}"
KEEP_ALIVE="${CYBERNH_LLM_KEEP_ALIVE:-0}"
export CYBERNH_LLM_CLI_SHOW_TIMING="${CYBERNH_LLM_CLI_SHOW_TIMING:-1}"

LLM_PID=""
STARTED_LLM=0

if ! command -v curl >/dev/null 2>&1; then
  echo "Error: curl is not installed or not in PATH."
  exit 1
fi

is_truthy() {
  case "${1:-}" in
    1|true|True|TRUE|yes|Yes|YES|on|On|ON)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

json_field() {
  local field="$1"
  python3 -c 'import json, sys; print(json.load(sys.stdin).get(sys.argv[1], ""))' "$field" 2>/dev/null || true
}

first_model_id() {
  python3 -c 'import json, sys; data=json.load(sys.stdin).get("data", []); print(data[0].get("id", "") if data else "")' 2>/dev/null || true
}

endpoint_model() {
  local model_from_health
  local model_from_models

  model_from_health="$(
    curl -fsS --max-time 2 "$BASE_URL/health" 2>/dev/null | json_field model
  )"
  if [[ -n "$model_from_health" ]]; then
    echo "$model_from_health"
    return 0
  fi

  model_from_models="$(
    curl -fsS --max-time 2 \
      -H "Authorization: Bearer $API_KEY" \
      "$BASE_URL/models" 2>/dev/null | first_model_id
  )"
  if [[ -n "$model_from_models" ]]; then
    echo "$model_from_models"
  fi
}

ensure_endpoint_model() {
  local running_model
  running_model="$(endpoint_model)"
  if [[ -n "$running_model" && "$running_model" != "$MODEL_NAME" ]]; then
    echo "Error: endpoint is already serving another model."
    echo "Endpoint: $BASE_URL"
    echo "Running model: $running_model"
    echo "Expected model: $MODEL_NAME"
    echo "Stop the existing LLM process first."
    exit 1
  fi
}

llm_endpoint_ready() {
  curl -fsS --max-time 2 \
    -H "Authorization: Bearer $API_KEY" \
    "$BASE_URL/models" >/dev/null 2>&1
}

llm_endpoint_port() {
  if [[ "$BASE_URL" =~ ^https?://(\[[^]]+\]|[^/:]+):([0-9]+) ]]; then
    echo "${BASH_REMATCH[2]}"
  elif [[ "$BASE_URL" == https://* ]]; then
    echo "443"
  else
    echo "80"
  fi
}

llm_listener_pid() {
  local port
  port="$(llm_endpoint_port)"
  lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n 1
}

check_llm_assets() {
  if [[ ! -x "$LLM_DIR/.venv/bin/python" ]]; then
    echo "Error: LLM virtualenv is missing: $LLM_DIR/.venv"
    echo "Run: $LLM_DIR/setup_modelscope.sh"
    exit 1
  fi

  if [[ ! -d "$MODEL_DIR" ]] || ! find "$MODEL_DIR" -maxdepth 1 -type f \( -name "*.safetensors" -o -name "*.bin" \) | grep -q .; then
    echo "Error: LLM model files are missing: $MODEL_DIR"
    echo "Run: $LLM_DIR/download_model.sh"
    exit 1
  fi
}

wait_for_llm_endpoint() {
  local deadline=$((SECONDS + LLM_READY_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    if llm_endpoint_ready; then
      return 0
    fi
    if [[ -n "$LLM_PID" ]] && ! kill -0 "$LLM_PID" >/dev/null 2>&1; then
      return 1
    fi
    sleep 2
  done
  return 1
}

cleanup_failed_background_start() {
  if [[ -n "$LLM_PID" ]] && kill -0 "$LLM_PID" >/dev/null 2>&1; then
    kill "$LLM_PID" >/dev/null 2>&1 || true
  fi
}

stop_started_llm() {
  if [[ "$STARTED_LLM" -eq 1 ]] && ! is_truthy "$KEEP_ALIVE"; then
    if [[ -n "$LLM_PID" ]] && kill -0 "$LLM_PID" >/dev/null 2>&1; then
      echo "Stopping LLM pid=$LLM_PID"
      kill "$LLM_PID" >/dev/null 2>&1 || true
    fi
    rm -f "$LLM_PID_FILE"
  fi
}

start_llm_background() {
  local listener_pid
  mkdir -p "$LLM_LOG_DIR" "$(dirname "$LLM_PID_FILE")"
  : > "$LLM_LOG_FILE"
  nohup "$LLM_DIR/serve_transformers.sh" >"$LLM_LOG_FILE" 2>&1 </dev/null &
  LLM_PID="$!"
  STARTED_LLM=1
  echo "$LLM_PID" > "$LLM_PID_FILE"
  echo "LLM pid: $LLM_PID"
  echo "LLM log: $LLM_LOG_FILE"
  echo "Waiting for LLM endpoint, timeout=${LLM_READY_TIMEOUT_SECONDS}s..."

  if wait_for_llm_endpoint; then
    listener_pid="$(llm_listener_pid || true)"
    if [[ -n "$listener_pid" ]]; then
      LLM_PID="$listener_pid"
      echo "$LLM_PID" > "$LLM_PID_FILE"
    fi
    ensure_endpoint_model
    echo "LLM endpoint is reachable: $BASE_URL"
    return 0
  fi

  cleanup_failed_background_start
  rm -f "$LLM_PID_FILE"
  echo "Error: LLM endpoint did not become reachable."
  if [[ -f "$LLM_LOG_FILE" ]]; then
    echo "Recent LLM log:"
    tail -n 20 "$LLM_LOG_FILE" || true
  fi
  return 1
}

run_cli_chat() {
  "$LLM_DIR/.venv/bin/python" "$LLM_DIR/chat_cli.py"
}

if llm_endpoint_ready; then
  mkdir -p "$(dirname "$LLM_PID_FILE")"
  listener_pid="$(llm_listener_pid || true)"
  if [[ -n "$listener_pid" ]]; then
    echo "$listener_pid" > "$LLM_PID_FILE"
  fi
  ensure_endpoint_model
  echo "LLM endpoint is already reachable: $BASE_URL"
  if [[ -n "${listener_pid:-}" ]]; then
    echo "LLM pid: $listener_pid"
  fi
  if is_truthy "$CHAT"; then
    run_cli_chat
  fi
  exit 0
fi

check_llm_assets

echo "Starting Cyber-NH LLM only"
echo "Endpoint: $BASE_URL"
echo "Model: $MODEL_NAME"
echo "Model path: $MODEL_DIR"

if is_truthy "$CHAT"; then
  if ! start_llm_background; then
    exit 1
  fi
  set +e
  run_cli_chat
  chat_status="$?"
  set -e
  stop_started_llm
  exit "$chat_status"
fi

if is_truthy "$BACKGROUND"; then
  start_llm_background
  exit "$?"
fi

echo "Running in foreground. Press Ctrl+C to stop."
exec "$LLM_DIR/serve_transformers.sh"
