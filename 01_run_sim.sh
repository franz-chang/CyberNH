#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

DEFAULT_PORT="${PORT:-4173}"
DEFAULT_LLM_DIR="$(cd "$ROOT_DIR/.." && pwd)/$(basename "$ROOT_DIR")-LLM"
LLM_DIR="${CYBERNH_LLM_DIR:-$DEFAULT_LLM_DIR}"
export CYBERNH_LLM_DIR="$LLM_DIR"
DEFAULT_LLM_MODEL="qwen3-vl-2b-instruct"
DEFAULT_LLM_MODEL_ID="Qwen/Qwen3-VL-2B-Instruct"
DEFAULT_LLM_MODEL_DIR="$LLM_DIR/models/Qwen3-VL-2B-Instruct"
DEFAULT_RULES_ADAPTER_DIR="$LLM_DIR/adapters/rules-lora"
LLM_LOG_DIR="$ROOT_DIR/runtime/logs"
LLM_LOG_FILE="$LLM_LOG_DIR/llm-serve.log"
LLM_START_MODE="${CYBERNH_START_LLM:-auto}"
LLM_READY_TIMEOUT_SECONDS="${CYBERNH_LLM_READY_TIMEOUT_SECONDS:-600}"
PROMPT_MODE="${CYBERNH_SYSTEM_PROMPT_MODE:-scenario_alias}"
REQUIRE_SCENARIO_ADAPTER="${CYBERNH_REQUIRE_SCENARIO_ADAPTER:-auto}"
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
    if [[ ( "$value" == \"*\" && "$value" == *\" ) || ( "$value" == \'*\' && "$value" == *\' ) ]]; then
      value="${value:1:${#value}-2}"
    fi
    if [[ -z "${!key+x}" ]]; then
      export "$key=$value"
    fi
  done < "$env_file"
}

set_env_if_unset() {
  local key="$1"
  local value="$2"
  if [[ -z "${!key+x}" ]]; then
    export "$key=$value"
  fi
}

set_local_2b_defaults() {
  set_env_if_unset CYBERNH_LLM_PROVIDER "modelscope-transformers"
  set_env_if_unset CYBERNH_LLM_MODEL "$DEFAULT_LLM_MODEL"
  set_env_if_unset CYBERNH_LLM_MODEL_ID "$DEFAULT_LLM_MODEL_ID"
  set_env_if_unset CYBERNH_LLM_LOCAL_DIR "$DEFAULT_LLM_MODEL_DIR"
  set_env_if_unset CYBERNH_LLM_BASE_URL "http://localhost:8000/v1"
  set_env_if_unset CYBERNH_LLM_API_KEY "EMPTY"
  set_env_if_unset CYBERNH_DEFAULT_AGENT_DECISION_MODE "llm_required"

  if [[ -z "${CYBERNH_LLM_ADAPTER_DIR+x}" ]]; then
    export CYBERNH_LLM_ADAPTER_DIR="$DEFAULT_RULES_ADAPTER_DIR"
  fi
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

prompt_mode_uses_aliases() {
  case "$PROMPT_MODE" in
    full|legacy|long)
      return 1
      ;;
    alias|aliases|scenario|scenario_alias|short)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

should_require_scenario_adapter() {
  if uses_deepseek_api; then
    return 1
  fi

  case "$REQUIRE_SCENARIO_ADAPTER" in
    1|true|True|TRUE|yes|Yes|YES|on|On|ON)
      return 0
      ;;
    0|false|False|FALSE|no|No|NO|off|Off|OFF)
      return 1
      ;;
    auto)
      prompt_mode_uses_aliases && is_local_llm_url
      return
      ;;
    *)
      echo "Unknown CYBERNH_REQUIRE_SCENARIO_ADAPTER=$REQUIRE_SCENARIO_ADAPTER. Use auto, 1, or 0."
      exit 1
      ;;
  esac
}

uses_deepseek_api() {
  [[ "${CYBERNH_DEFAULT_AGENT_DECISION_MODE:-llm_required}" == "deepseek_api" ]]
}

llm_endpoint_ready() {
  local base_url="${CYBERNH_LLM_BASE_URL:-http://localhost:8000/v1}"
  base_url="${base_url%/}"
  curl -fsS --max-time 2 \
    -H "Authorization: Bearer ${CYBERNH_LLM_API_KEY:-EMPTY}" \
    "$base_url/models" >/dev/null 2>&1
}

llm_health_json() {
  local base_url="${CYBERNH_LLM_BASE_URL:-http://localhost:8000/v1}"
  base_url="${base_url%/}"
  curl -fsS --max-time 5 \
    -H "Authorization: Bearer ${CYBERNH_LLM_API_KEY:-EMPTY}" \
    "$base_url/health" 2>/dev/null
}

json_field() {
  local field="$1"
  node -e '
const field = process.argv[1];
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(input);
    const value = parsed && parsed[field];
    if (value !== undefined && value !== null) process.stdout.write(String(value));
  } catch {}
});
' "$field"
}

json_first_model_id() {
  node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(input);
    const value = parsed && parsed.data && parsed.data[0] && parsed.data[0].id;
    if (value !== undefined && value !== null) process.stdout.write(String(value));
  } catch {}
});
'
}

llm_endpoint_model() {
  local base_url="${CYBERNH_LLM_BASE_URL:-http://localhost:8000/v1}"
  local health model models_json
  base_url="${base_url%/}"

  health="$(llm_health_json || true)"
  model="$(printf '%s' "$health" | json_field model)"
  if [[ -n "$model" ]]; then
    echo "$model"
    return 0
  fi

  models_json="$(
    curl -fsS --max-time 5 \
      -H "Authorization: Bearer ${CYBERNH_LLM_API_KEY:-EMPTY}" \
      "$base_url/models" 2>/dev/null || true
  )"
  printf '%s' "$models_json" | json_first_model_id
}

verify_expected_llm_model() {
  local expected_model="${CYBERNH_LLM_MODEL:-$DEFAULT_LLM_MODEL}"
  local running_model
  running_model="$(llm_endpoint_model || true)"
  if [[ -z "$running_model" ]]; then
    return 0
  fi
  if [[ "$running_model" != "$expected_model" ]]; then
    echo "Error: LLM endpoint model mismatch."
    echo "Expected: $expected_model"
    echo "Running:  $running_model"
    return 1
  fi
  echo "LLM model verified: $running_model"
}

stop_llm_listener() {
  local pid
  pid="$(llm_listener_pid || true)"
  [[ -n "$pid" ]] || return 0

  echo "Stopping existing local LLM server pid=$pid"
  kill "$pid" >/dev/null 2>&1 || true
  for _ in {1..30}; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  if kill -0 "$pid" >/dev/null 2>&1; then
    echo "Force stopping local LLM server pid=$pid"
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
}

verify_scenario_adapter() {
  if ! should_require_scenario_adapter; then
    return 0
  fi

  local expected_adapter="${CYBERNH_LLM_ADAPTER_DIR:-}"
  local health loaded_adapter
  health="$(llm_health_json || true)"
  loaded_adapter="$(printf '%s' "$health" | json_field adapter)"

  if [[ -z "$loaded_adapter" ]]; then
    echo "Error: CYBERNH_SYSTEM_PROMPT_MODE=$PROMPT_MODE uses short scenario tags, but the LLM health endpoint did not report a loaded adapter."
    echo "Set CYBERNH_LLM_ADAPTER_DIR=$DEFAULT_RULES_ADAPTER_DIR, or run with:"
    echo "  CYBERNH_SYSTEM_PROMPT_MODE=full ./01_run_sim.sh"
    exit 1
  fi

  if [[ -n "$expected_adapter" && "$loaded_adapter" != "$expected_adapter" ]]; then
    echo "Error: loaded LLM adapter does not match CYBERNH_LLM_ADAPTER_DIR."
    echo "Expected: $expected_adapter"
    echo "Loaded:   $loaded_adapter"
    exit 1
  fi

  echo "Scenario adapter verified: $loaded_adapter"
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
  local model_dir="${CYBERNH_LLM_LOCAL_DIR:-$DEFAULT_LLM_MODEL_DIR}"
  local adapter_dir="${CYBERNH_LLM_ADAPTER_DIR:-}"
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
  if should_require_scenario_adapter; then
    if [[ -z "$adapter_dir" || ! -d "$adapter_dir" ]]; then
      echo "LLM adapter directory is missing for short scenario-tag mode: ${adapter_dir:-<unset>}"
      echo "Expected adapter: $DEFAULT_RULES_ADAPTER_DIR"
      echo "Either restore the adapter or run with: CYBERNH_SYSTEM_PROMPT_MODE=full ./01_run_sim.sh"
      return 1
    fi
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
  if uses_deepseek_api && [[ -z "${CYBERNH_DEEPSEEK_API_KEY:-}" ]]; then
    echo "Warning: CYBERNH_DEEPSEEK_API_KEY is not set. DeepSeek requests will fail until it is configured."
  fi

  if uses_deepseek_api && [[ "$LLM_START_MODE" == "auto" ]]; then
    if llm_endpoint_ready; then
      local running_model expected_model
      expected_model="${CYBERNH_LLM_MODEL:-$DEFAULT_LLM_MODEL}"
      running_model="$(llm_endpoint_model || true)"
      if [[ -n "$running_model" && "$running_model" != "$expected_model" ]]; then
        echo "Optional local Qwen endpoint is reachable, but serving a different model."
        echo "Expected local model: $expected_model"
        echo "Running local model:  $running_model"
      fi
      echo "Optional local Qwen endpoint is already reachable: ${CYBERNH_LLM_BASE_URL:-http://localhost:8000/v1}"
    else
      echo "DeepSeek API mode detected; skipping local Qwen auto-start."
    fi
    return 0
  fi

  if llm_endpoint_ready; then
    if verify_expected_llm_model; then
      echo "LLM endpoint is already reachable: ${CYBERNH_LLM_BASE_URL:-http://localhost:8000/v1}"
      return
    fi

    if should_attempt_llm_start && is_local_llm_url; then
      stop_llm_listener
    else
      echo "Set CYBERNH_START_LLM=1 and use a local endpoint to restart with ${CYBERNH_LLM_MODEL:-$DEFAULT_LLM_MODEL}."
      exit 1
    fi
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
  echo "LLM model: ${CYBERNH_LLM_MODEL:-$DEFAULT_LLM_MODEL}"
  echo "LLM model dir: ${CYBERNH_LLM_LOCAL_DIR:-$DEFAULT_LLM_MODEL_DIR}"
  if [[ -n "${CYBERNH_LLM_ADAPTER_DIR:-}" ]]; then
    echo "LLM adapter: $CYBERNH_LLM_ADAPTER_DIR"
  fi
  echo "LLM log: $LLM_LOG_FILE"
  "$LLM_DIR/serve_transformers.sh" >"$LLM_LOG_FILE" 2>&1 &
  LLM_PID="$!"

  echo "Waiting for LLM endpoint, timeout=${LLM_READY_TIMEOUT_SECONDS}s..."
  if wait_for_llm_endpoint; then
    LLM_PID="$(llm_listener_pid || true)"
    verify_expected_llm_model
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

set_local_2b_defaults
load_env_defaults "$LLM_DIR/.env"
load_env_defaults "$ROOT_DIR/config/deepseek.env"
PROMPT_MODE="${CYBERNH_SYSTEM_PROMPT_MODE:-scenario_alias}"
REQUIRE_SCENARIO_ADAPTER="${CYBERNH_REQUIRE_SCENARIO_ADAPTER:-auto}"
LLM_START_MODE="${CYBERNH_START_LLM:-auto}"

trap cleanup EXIT INT TERM
start_llm_if_needed
verify_scenario_adapter

PORT="$(find_free_port "$DEFAULT_PORT")"
export PORT

echo "Starting Cyber-NH from: $ROOT_DIR"
echo "Dashboard URL: http://localhost:$PORT"
if uses_deepseek_api; then
  echo "Default LLM provider: DeepSeek API"
  echo "DeepSeek endpoint: ${CYBERNH_DEEPSEEK_BASE_URL:-https://api.deepseek.com}"
  echo "DeepSeek model: ${CYBERNH_DEEPSEEK_MODEL:-deepseek-v4-flash}"
  if llm_endpoint_ready; then
    echo "Optional local Qwen endpoint: ${CYBERNH_LLM_BASE_URL:-http://localhost:8000/v1}"
    echo "Optional local Qwen model: ${CYBERNH_LLM_MODEL:-qwen3-vl-2b-instruct}"
  else
    echo "Optional local Qwen endpoint: not started"
  fi
else
  echo "LLM endpoint: ${CYBERNH_LLM_BASE_URL:-http://localhost:8000/v1}"
  echo "LLM model: ${CYBERNH_LLM_MODEL:-qwen3-vl-2b-instruct}"
fi
echo "System prompt mode: $PROMPT_MODE"
echo "LLM start mode: $LLM_START_MODE"
echo "Press Ctrl+C to stop."

npm start
