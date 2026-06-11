#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RULES_FT_DIR="$ROOT_DIR/runtime/fine_tuning/rules"
SCENARIO_DIR="$ROOT_DIR/runtime/fine_tuning/system_scenarios"
DEFAULT_LLM_DIR="$(cd "$ROOT_DIR/.." && pwd)/$(basename "$ROOT_DIR")-LLM"
LLM_DIR="${CYBERNH_LLM_DIR:-$DEFAULT_LLM_DIR}"
PYTHON_BIN="${CYBERNH_LLM_PYTHON:-$LLM_DIR/.venv/bin/python}"
MODEL_DIR="${CYBERNH_LLM_LOCAL_DIR:-$LLM_DIR/models/Qwen3-VL-2B-Instruct}"
OUTPUT_DIR="${CYBERNH_RULES_ADAPTER_DIR:-$LLM_DIR/adapters/rules-lora}"
TRAIN_FILE="$RULES_FT_DIR/data/train_rules_augmented.jsonl"
EVAL_FILE="$RULES_FT_DIR/data/eval_rules.jsonl"
REPEAT="${CYBERNH_RULES_FINETUNE_REPEAT:-2}"
INSTALL_DEPS="${CYBERNH_FINETUNE_INSTALL_DEPS:-1}"
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

"$PYTHON_BIN" "$RULES_FT_DIR/build_rules_dataset.py" \
  --train-output "$TRAIN_FILE" \
  --eval-output "$EVAL_FILE" \
  --repeat "$REPEAT" \
  --include-system-anchors

if [[ "$INSTALL_DEPS" == "1" || "$INSTALL_DEPS" == "true" ]]; then
  "$PYTHON_BIN" - <<'PY' >/dev/null 2>&1 || "$PYTHON_BIN" -m pip install --upgrade peft
import peft
PY
fi

exec "$PYTHON_BIN" "$SCENARIO_DIR/train_lora.py" \
  --model-dir "$MODEL_DIR" \
  --train-file "$TRAIN_FILE" \
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
  --manifest-task "CyberNH rules and resident-priority reasoning" \
  --manifest-file "cybernh_rules_manifest.json" \
  --manifest-extra-json '{"rule_sources":["rules/datasets/train_seed.jsonl","rules/datasets/eval_cases.jsonl","rules/structured/rules.jsonl","rules/structured/metrics.jsonl"],"includes_system_scenario_anchors":true}' \
  "$@"
