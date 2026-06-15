#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_URL="${CYBERNH_LLM_BASE_URL:-http://localhost:8000/v1}"
BASE_URL="${BASE_URL%/}"
API_KEY="${CYBERNH_LLM_API_KEY:-EMPTY}"
SAMPLE_SIZE="${GSM8K_SAMPLE_SIZE:-10}"
SEED="${GSM8K_SEED:-$(python3 -c 'import secrets; print(secrets.randbits(32))')}"
MAX_TOKENS="${GSM8K_MAX_TOKENS:-256}"
TIMEOUT_SECONDS="${GSM8K_TIMEOUT_SECONDS:-300}"
READY_TIMEOUT_SECONDS="${CYBERNH_LLM_READY_TIMEOUT_SECONDS:-900}"
RUN_ID="$(date +%Y%m%d_%H%M%S)"
RUN_DIR="$ROOT_DIR/runtime/benchmarks/runs/gsm8k_compare_$RUN_ID"
DATASET_CACHE="$ROOT_DIR/runtime/benchmarks/data/gsm8k_test.jsonl"
SAMPLE_FILE="$RUN_DIR/sample.jsonl"
RESULTS_JSONL="$RUN_DIR/results.jsonl"
SUMMARY_CSV="$RUN_DIR/summary.csv"

endpoint_port() {
  python3 - "$BASE_URL" <<'PY'
import sys
from urllib.parse import urlparse
parsed = urlparse(sys.argv[1])
if parsed.port:
    print(parsed.port)
elif parsed.scheme == "https":
    print(443)
else:
    print(80)
PY
}

json_field() {
  local field="$1"
  python3 -c 'import json, sys; print(json.load(sys.stdin).get(sys.argv[1], ""))' "$field" 2>/dev/null || true
}

endpoint_model() {
  curl -fsS --max-time 2 "$BASE_URL/health" 2>/dev/null | json_field model
}

listener_pid() {
  local port
  port="$(endpoint_port)"
  lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n 1
}

stop_current_llm() {
  local pid
  local model
  pid="$(listener_pid || true)"
  [[ -n "$pid" ]] || return 0

  model="$(endpoint_model || true)"
  if [[ -z "$model" || "$model" != qwen3-vl-* ]]; then
    echo "Error: port $BASE_URL is occupied by pid=$pid but it does not look like a Cyber-NH Qwen endpoint."
    echo "Refusing to stop it automatically."
    exit 1
  fi

  echo "Stopping existing LLM pid=$pid model=$model"
  kill "$pid" >/dev/null 2>&1 || true
  for _ in {1..30}; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if kill -0 "$pid" >/dev/null 2>&1; then
    echo "Force stopping LLM pid=$pid"
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$ROOT_DIR/runtime/llm.pid"
}

require_expected_model() {
  local expected="$1"
  local running
  running="$(endpoint_model || true)"
  if [[ "$running" != "$expected" ]]; then
    echo "Error: expected endpoint model $expected, got ${running:-none}"
    exit 1
  fi
}

run_one_model() {
  local label="$1"
  local script="$2"
  local model="$3"

  echo
  echo "=== $label: starting $model ==="
  stop_current_llm
  CYBERNH_LLM_CHAT=0 \
    CYBERNH_LLM_BACKGROUND=1 \
    CYBERNH_LLM_KEEP_ALIVE=1 \
    CYBERNH_LLM_READY_TIMEOUT_SECONDS="$READY_TIMEOUT_SECONDS" \
    CYBERNH_LLM_MAX_TOKENS="$MAX_TOKENS" \
    "$ROOT_DIR/$script"
  require_expected_model "$model"

  echo "=== $label: GSM8K benchmark ==="
  python3 "$ROOT_DIR/runtime/benchmarks/gsm8k_compare.py" \
    --model-label "$label" \
    --model "$model" \
    --base-url "$BASE_URL" \
    --api-key "$API_KEY" \
    --dataset-cache "$DATASET_CACHE" \
    --sample-file "$SAMPLE_FILE" \
    --results-jsonl "$RESULTS_JSONL" \
    --summary-csv "$SUMMARY_CSV" \
    --sample-size "$SAMPLE_SIZE" \
    --seed "$SEED" \
    --max-tokens "$MAX_TOKENS" \
    --temperature 0 \
    --timeout-seconds "$TIMEOUT_SECONDS"

  stop_current_llm
}

mkdir -p "$RUN_DIR"

echo "GSM8K compare run"
echo "Run dir: $RUN_DIR"
echo "Seed: $SEED"
echo "Sample size: $SAMPLE_SIZE"
echo "Max tokens: $MAX_TOKENS"

run_one_model "2B" "S2_Start_2B_IN.sh" "qwen3-vl-2b-instruct"
run_one_model "4B" "S3_Start_4B_IN.sh" "qwen3-vl-4b-instruct"

echo
echo "=== Summary ==="
column -s, -t < "$SUMMARY_CSV" || cat "$SUMMARY_CSV"
echo
echo "Results JSONL: $RESULTS_JSONL"
echo "Summary CSV: $SUMMARY_CSV"
echo "Sample file: $SAMPLE_FILE"
