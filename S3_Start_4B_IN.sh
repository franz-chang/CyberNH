#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_LLM_DIR="$(cd "$ROOT_DIR/.." && pwd)/$(basename "$ROOT_DIR")-LLM"
LLM_DIR="${CYBERNH_LLM_DIR:-$DEFAULT_LLM_DIR}"

export CYBERNH_ROOT_DIR="$ROOT_DIR"
export CYBERNH_LLM_DIR="$LLM_DIR"
export CYBERNH_LLM_PROVIDER="modelscope-transformers"
export CYBERNH_LLM_MODEL="qwen3-vl-4b-instruct"
export CYBERNH_LLM_MODEL_ID="Qwen/Qwen3-VL-4B-Instruct"
export CYBERNH_LLM_LOCAL_DIR="$LLM_DIR/models/Qwen3-VL-4B-Instruct"
export CYBERNH_LLM_ADAPTER_DIR=""
export CYBERNH_LLM_CHAT="${CYBERNH_LLM_CHAT:-1}"
export CYBERNH_LLM_CLI_SHOW_TIMING="${CYBERNH_LLM_CLI_SHOW_TIMING:-1}"
export CYBERNH_LLM_CLI_SYSTEM_PROMPT="${CYBERNH_LLM_CLI_SYSTEM_PROMPT:-You are Qwen3-VL-4B-Instruct running locally for Cyber-NH. Answer clearly and keep context across turns.}"

exec "$ROOT_DIR/runtime/scripts/start_local_llm.sh"
