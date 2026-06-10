#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCENARIO_DIR="$ROOT_DIR/runtime/fine_tuning/system_scenarios"
DEFAULT_LLM_DIR="$(cd "$ROOT_DIR/.." && pwd)/$(basename "$ROOT_DIR")-LLM"
LLM_DIR="${CYBERNH_LLM_DIR:-$DEFAULT_LLM_DIR}"
PYTHON_BIN="${CYBERNH_LLM_PYTHON:-$LLM_DIR/.venv/bin/python}"
MODEL_DIR="${CYBERNH_LLM_LOCAL_DIR:-$LLM_DIR/models/Qwen3-VL-2B-Instruct}"
OUTPUT_DIR="${CYBERNH_SCENARIO_ADAPTER_DIR:-$LLM_DIR/adapters/system-scenarios-lora}"
INSTALL_DEPS="${CYBERNH_FINETUNE_INSTALL_DEPS:-1}"

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Error: Python venv not found: $PYTHON_BIN"
  echo "Run: $LLM_DIR/setup_modelscope.sh"
  exit 1
fi

if [[ ! -d "$MODEL_DIR" ]]; then
  echo "Error: model directory not found: $MODEL_DIR"
  exit 1
fi

"$PYTHON_BIN" "$SCENARIO_DIR/validate_dataset.py" \
  "$SCENARIO_DIR/data/train.jsonl" \
  "$SCENARIO_DIR/data/eval.jsonl"

if [[ "$INSTALL_DEPS" == "1" || "$INSTALL_DEPS" == "true" ]]; then
  "$PYTHON_BIN" - <<'PY' >/dev/null 2>&1 || "$PYTHON_BIN" -m pip install --upgrade peft
import peft
PY
fi

exec "$PYTHON_BIN" "$SCENARIO_DIR/train_lora.py" \
  --model-dir "$MODEL_DIR" \
  --train-file "$SCENARIO_DIR/data/train.jsonl" \
  --eval-file "$SCENARIO_DIR/data/eval.jsonl" \
  --output-dir "$OUTPUT_DIR" \
  "$@"
