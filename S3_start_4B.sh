#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_LLM_DIR="$(cd "$ROOT_DIR/.." && pwd)/$(basename "$ROOT_DIR")-LLM"
LLM_DIR="${CYBERNH_LLM_DIR:-$DEFAULT_LLM_DIR}"
S1_SCRIPT="$ROOT_DIR/S1_Start_llm.sh"

TARGET_MODEL="qwen3-vl-4b-instruct"
TARGET_MODEL_ID="Qwen/Qwen3-VL-4B-Instruct"
TARGET_MODEL_DIR="$LLM_DIR/models/Qwen3-VL-4B-Instruct"

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

json_field() {
  local field="$1"
  python3 -c 'import json, sys; print(json.load(sys.stdin).get(sys.argv[1], ""))' "$field" 2>/dev/null || true
}

first_model_id() {
  python3 -c 'import json, sys; data=json.load(sys.stdin).get("data", []); print(data[0].get("id", "") if data else "")' 2>/dev/null || true
}

endpoint_model() {
  local base_url="$1"
  local api_key="$2"
  local model_from_health
  local model_from_models

  model_from_health="$(
    curl -fsS --max-time 2 "${base_url%/}/health" 2>/dev/null | json_field model
  )"
  if [[ -n "$model_from_health" ]]; then
    echo "$model_from_health"
    return 0
  fi

  model_from_models="$(
    curl -fsS --max-time 2 \
      -H "Authorization: Bearer $api_key" \
      "${base_url%/}/models" 2>/dev/null | first_model_id
  )"
  if [[ -n "$model_from_models" ]]; then
    echo "$model_from_models"
  fi
}

load_env_defaults "$LLM_DIR/.env"

export CYBERNH_LLM_DIR="$LLM_DIR"
export CYBERNH_LLM_PROVIDER="modelscope-transformers"
export CYBERNH_LLM_MODEL="$TARGET_MODEL"
export CYBERNH_LLM_MODEL_ID="$TARGET_MODEL_ID"
export CYBERNH_LLM_LOCAL_DIR="$TARGET_MODEL_DIR"
export CYBERNH_LLM_ADAPTER_DIR=""
export CYBERNH_LLM_CHAT="${CYBERNH_LLM_CHAT:-1}"
export CYBERNH_LLM_CLI_SYSTEM_PROMPT="${CYBERNH_LLM_CLI_SYSTEM_PROMPT:-You are Qwen3-VL-4B-Instruct running locally for Cyber-NH. Answer clearly and keep context across turns.}"

BASE_URL="${CYBERNH_LLM_BASE_URL:-http://localhost:8000/v1}"
API_KEY="${CYBERNH_LLM_API_KEY:-EMPTY}"

if [[ ! -x "$S1_SCRIPT" ]]; then
  echo "Error: missing launcher: $S1_SCRIPT"
  exit 1
fi

if [[ ! -d "$TARGET_MODEL_DIR" ]]; then
  echo "Error: Qwen3-VL-4B-Instruct model directory is missing: $TARGET_MODEL_DIR"
  echo "Download it with ModelScope first."
  exit 1
fi

running_model="$(endpoint_model "$BASE_URL" "$API_KEY")"
if [[ -n "$running_model" && "$running_model" != "$TARGET_MODEL" ]]; then
  echo "Error: endpoint is already serving another model."
  echo "Endpoint: $BASE_URL"
  echo "Running model: $running_model"
  echo "Expected model: $TARGET_MODEL"
  echo "Stop the existing LLM process first, then rerun: $0"
  exit 1
fi

echo "Starting Cyber-NH Qwen3-VL-4B-Instruct"
echo "LLM dir: $LLM_DIR"
echo "Model dir: $TARGET_MODEL_DIR"
echo "Endpoint: ${BASE_URL%/}"

exec "$S1_SCRIPT"
