#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

DEFAULT_PORT="${PORT:-4173}"
DEFAULT_LLM_DIR="$(cd "$ROOT_DIR/.." && pwd)/$(basename "$ROOT_DIR")-LLM"
LLM_DIR="${CYBERNH_LLM_DIR:-$DEFAULT_LLM_DIR}"
export CYBERNH_LLM_DIR="$LLM_DIR"
LLM_LOG_DIR="$ROOT_DIR/runtime/logs"
LLM_LOG_FILE="$LLM_LOG_DIR/llm-serve.log"
LLM_START_MODE="${CYBERNH_START_LLM:-auto}"
LLM_READY_TIMEOUT_SECONDS="${CYBERNH_LLM_READY_TIMEOUT_SECONDS:-600}"
LLM_PID=""

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
    if [[ -z "${!key+x}" ]]; then
      export "$key=$value"
    fi
  done < "$env_file"
}

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is not installed or not in PATH."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is not installed or not in PATH."
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "Error: curl is not installed or not in PATH."
  exit 1
fi

find_free_port() {
  local port="$1"
  while lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; do
    port=$((port + 1))
  done
  echo "$port"
}

is_local_llm_url() {
  local url="${CYBERNH_LLM_BASE_URL:-http://localhost:8000/v1}"
  [[ "$url" == http://localhost:* || "$url" == http://127.0.0.1:* || "$url" == http://[::1]:* ]]
}

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

llm_endpoint_ready() {
  local base_url="${CYBERNH_LLM_BASE_URL:-http://localhost:8000/v1}"
  base_url="${base_url%/}"
  curl -fsS --max-time 2 \
    -H "Authorization: Bearer ${CYBERNH_LLM_API_KEY:-EMPTY}" \
    "$base_url/models" >/dev/null 2>&1
}

llm_endpoint_port() {
  local base_url="${CYBERNH_LLM_BASE_URL:-http://localhost:8000/v1}"
  if [[ "$base_url" =~ ^https?://(\[[^]]+\]|[^/:]+):([0-9]+) ]]; then
    echo "${BASH_REMATCH[2]}"
  elif [[ "$base_url" == https://* ]]; then
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

should_attempt_llm_start() {
  case "$LLM_START_MODE" in
    0|false|False|FALSE|no|No|NO|off|Off|OFF)
      return 1
      ;;
    1|true|True|TRUE|yes|Yes|YES|on|On|ON)
      return 0
      ;;
    auto)
      is_local_llm_url
      return
      ;;
    *)
      echo "Unknown CYBERNH_START_LLM=$LLM_START_MODE. Use auto, 1, or 0."
      exit 1
      ;;
  esac
}

check_llm_assets() {
  local model_dir="${CYBERNH_LLM_LOCAL_DIR:-$LLM_DIR/models/Qwen3-VL-2B-Instruct}"
  if [[ ! -x "$LLM_DIR/.venv/bin/python" ]]; then
    echo "LLM virtualenv is missing: $LLM_DIR/.venv"
    echo "Run: $LLM_DIR/setup_modelscope.sh"
    return 1
  fi
  if [[ ! -d "$model_dir" ]] || ! find "$model_dir" -maxdepth 1 -type f \( -name "*.safetensors" -o -name "*.bin" \) | grep -q .; then
    echo "LLM model files are missing: $model_dir"
    echo "Run: $LLM_DIR/download_model.sh"
    return 1
  fi
  return 0
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

start_llm_if_needed() {
  if llm_endpoint_ready; then
    echo "LLM endpoint is already reachable: ${CYBERNH_LLM_BASE_URL:-http://localhost:8000/v1}"
    return
  fi

  if ! should_attempt_llm_start; then
    echo "Error: LLM endpoint is not reachable and local LLM startup is disabled."
    echo "Endpoint: ${CYBERNH_LLM_BASE_URL:-http://localhost:8000/v1}"
    echo "Set CYBERNH_START_LLM=1 to force starting the local LLM server."
    exit 1
  fi

  if ! check_llm_assets; then
    exit 1
  fi

  mkdir -p "$LLM_LOG_DIR"
  : > "$LLM_LOG_FILE"
  echo "Starting local LLM server in background..."
  echo "LLM log: $LLM_LOG_FILE"
  "$LLM_DIR/serve_transformers.sh" >"$LLM_LOG_FILE" 2>&1 &
  LLM_PID="$!"

  echo "Waiting for LLM endpoint, timeout=${LLM_READY_TIMEOUT_SECONDS}s..."
  if wait_for_llm_endpoint; then
    LLM_PID="$(llm_listener_pid || true)"
    echo "LLM endpoint is reachable: ${CYBERNH_LLM_BASE_URL:-http://localhost:8000/v1}"
    return
  fi

  if [[ -n "$LLM_PID" ]] && kill -0 "$LLM_PID" >/dev/null 2>&1; then
    echo "Error: LLM endpoint did not become reachable before timeout."
  else
    echo "Error: LLM server did not stay running."
  fi
  if [[ -f "$LLM_LOG_FILE" ]]; then
    echo "Recent LLM log:"
    tail -n 20 "$LLM_LOG_FILE" || true
  fi
  exit 1
}

cleanup() {
  if [[ -n "$LLM_PID" ]] && kill -0 "$LLM_PID" >/dev/null 2>&1; then
    echo
    echo "Stopping local LLM server pid=$LLM_PID"
    kill "$LLM_PID" >/dev/null 2>&1 || true
  fi
}

if [[ ! -d node_modules ]]; then
  echo "Installing dependencies..."
  npm install
fi

load_env_defaults "$LLM_DIR/.env"

trap cleanup EXIT INT TERM
start_llm_if_needed

PORT="$(find_free_port "$DEFAULT_PORT")"
export PORT

echo "Starting Cyber-NH from: $ROOT_DIR"
echo "Dashboard URL: http://localhost:$PORT"
echo "LLM endpoint: ${CYBERNH_LLM_BASE_URL:-http://localhost:8000/v1}"
echo "LLM model: ${CYBERNH_LLM_MODEL:-qwen3-vl-2b-instruct}"
echo "LLM start mode: $LLM_START_MODE"
echo "Press Ctrl+C to stop."

npm start
