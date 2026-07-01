#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_DIR}"

python3 -m venv idea
source idea/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m pip install -e .

echo "IDEA-Agent environment is ready."
echo "Activate it with: source ${PROJECT_DIR}/idea/bin/activate"
