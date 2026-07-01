#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/home/staff_xiaobo_jin/IDEA-Agent"
INPUT_FILE="${PROJECT_DIR}/input/SciGraph-LLM.pdf"
OUTPUT_DIR="${PROJECT_DIR}/outputs/SciGraph-LLM"
DOC_ID="SciGraph-LLM"
CONFIG_FILE="${PROJECT_DIR}/config.yaml"
VENV_DIR="${PROJECT_DIR}/idea"
IDEA_AGENT_BIN="${VENV_DIR}/bin/idea-agent"
PYTHON_BIN="${VENV_DIR}/bin/python"
START_EPOCH="$(date +%s)"
START_TIME="$(date '+%Y-%m-%d %H:%M:%S %z')"

on_exit() {
  status=$?
  end_epoch="$(date +%s)"
  end_time="$(date '+%Y-%m-%d %H:%M:%S %z')"
  elapsed=$((end_epoch - START_EPOCH))
  echo
  echo "IDEA-Agent task finished"
  echo "  status: ${status}"
  echo "  started_at: ${START_TIME}"
  echo "  finished_at: ${end_time}"
  echo "  wall_elapsed_seconds: ${elapsed}"
  if [[ ${status} -eq 0 ]]; then
    echo "  output_dir: ${OUTPUT_DIR}"
    echo "  report: ${OUTPUT_DIR}/pipeline_report.json"
    echo "  timing: ${OUTPUT_DIR}/timing.json"
  fi
}

trap on_exit EXIT

if [[ ! -f "${INPUT_FILE}" ]]; then
  echo "Input PDF not found: ${INPUT_FILE}" >&2
  echo "Please upload the paper there first, then rerun this script." >&2
  exit 1
fi

if [[ ! -f "${CONFIG_FILE}" ]]; then
  echo "Config file not found: ${CONFIG_FILE}" >&2
  exit 1
fi

if [[ ! -f "${PYTHON_BIN}" || ! -x "${IDEA_AGENT_BIN}" ]]; then
  echo "Virtual environment not found: ${VENV_DIR}" >&2
  echo "Run scripts/bootstrap_env.sh first if the environment was removed." >&2
  exit 1
fi

cd "${PROJECT_DIR}"
mkdir -p "${OUTPUT_DIR}"
export PYTHONPATH="${PROJECT_DIR}:${PYTHONPATH:-}"

echo "Starting IDEA-Agent extraction"
echo "  input: ${INPUT_FILE}"
echo "  output: ${OUTPUT_DIR}"
echo "  doc_id: ${DOC_ID}"
echo "  started_at: ${START_TIME}"

"${IDEA_AGENT_BIN}" compile "${INPUT_FILE}" \
  --doc-id "${DOC_ID}" \
  --output "${OUTPUT_DIR}" \
  --config "${CONFIG_FILE}" \
  --span-mode lazy \
  --chunk-max-chars 3200 \
  --evidence-backend auto

"${PYTHON_BIN}" - <<PY
import json
from pathlib import Path

report_path = Path("${OUTPUT_DIR}") / "pipeline_report.json"
if report_path.exists():
    report = json.loads(report_path.read_text(encoding="utf-8"))
    print("Pipeline timing")
    print(f"  total_seconds: {report.get('total_seconds', 0):.6f}")
    for name, seconds in report.get("stage_seconds", {}).items():
        print(f"  {name}: {seconds:.6f}")
PY

echo "Done. Results are in: ${OUTPUT_DIR}"
