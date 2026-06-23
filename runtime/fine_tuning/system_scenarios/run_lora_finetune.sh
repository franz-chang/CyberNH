#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCENARIO_DIR="$ROOT_DIR/runtime/fine_tuning/system_scenarios"
DEFAULT_LLM_DIR="$(cd "$ROOT_DIR/.." && pwd)/$(basename "$ROOT_DIR")-LLM"
LLM_DIR="${CYBERNH_LLM_DIR:-$DEFAULT_LLM_DIR}"

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

PYTHON_BIN="${CYBERNH_LLM_PYTHON:-$LLM_DIR/.venv/bin/python}"
MODEL_DIR="${CYBERNH_LLM_LOCAL_DIR:-$LLM_DIR/models/Qwen3-8B-Instruct}"
OUTPUT_DIR="${CYBERNH_SCENARIO_ADAPTER_DIR:-$LLM_DIR/adapters/system-scenarios-lora-qwen3-8b}"
INSTALL_DEPS="${CYBERNH_FINETUNE_INSTALL_DEPS:-1}"
BASE_TRAIN_FILE="$SCENARIO_DIR/data/train.jsonl"
RUNTIME_TRAIN_FILE="$SCENARIO_DIR/data/train_runtime.jsonl"
AUGMENTED_TRAIN_FILE="$SCENARIO_DIR/data/train_augmented_runtime.jsonl"
EVAL_FILE="$SCENARIO_DIR/data/eval.jsonl"
export PYTHONUNBUFFERED="${PYTHONUNBUFFERED:-1}"

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Error: Python venv not found: $PYTHON_BIN"
  echo "Run: $LLM_DIR/setup_modelscope.sh"
  exit 1
fi

if [[ ! -d "$MODEL_DIR" ]]; then
  echo "Error: model directory not found: $MODEL_DIR"
  exit 1
fi

"$PYTHON_BIN" "$SCENARIO_DIR/build_runtime_payload_dataset.py" \
  "$BASE_TRAIN_FILE" \
  "$RUNTIME_TRAIN_FILE"

"$PYTHON_BIN" "$SCENARIO_DIR/build_runtime_payload_dataset.py" \
  "$BASE_TRAIN_FILE" \
  "$AUGMENTED_TRAIN_FILE" \
  --include-boundary-cases \
  --include-regression-anchors "$EVAL_FILE" \
  --repeat 2

"$PYTHON_BIN" "$SCENARIO_DIR/validate_dataset.py" \
  "$BASE_TRAIN_FILE" \
  "$RUNTIME_TRAIN_FILE" \
  "$AUGMENTED_TRAIN_FILE" \
  "$EVAL_FILE"

if [[ "$INSTALL_DEPS" == "1" || "$INSTALL_DEPS" == "true" ]]; then
  "$PYTHON_BIN" - <<'PY' >/dev/null 2>&1 || "$PYTHON_BIN" -m pip install --upgrade peft
import peft
PY
fi

exec "$PYTHON_BIN" "$SCENARIO_DIR/train_lora.py" \
  --model-dir "$MODEL_DIR" \
  --train-file "$AUGMENTED_TRAIN_FILE" \
  --eval-file "$EVAL_FILE" \
  --output-dir "$OUTPUT_DIR" \
  --max-steps 160 \
  --epochs 40 \
  --batch-size 1 \
  --grad-accum 1 \
  --learning-rate 0.0003 \
  --lora-rank 8 \
  --lora-alpha 16 \
  --lora-dropout 0 \
  "$@"
