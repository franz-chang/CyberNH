#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT_DIR" ]]; then
  echo "Error: this directory is not inside a git repository."
  exit 1
fi

cd "$ROOT_DIR"

REMOTE="${GIT_REMOTE:-origin}"
BRANCH="${GIT_BRANCH:-$(git branch --show-current)}"
DEFAULT_REMOTE_URL="${GIT_REMOTE_URL:-git@github.com:franz-chang/CyberNH.git}"
RUN_CHECKS="${RUN_CHECKS:-1}"

if [[ -z "$BRANCH" ]]; then
  echo "Error: detached HEAD is not supported by this helper."
  exit 1
fi

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  echo "Remote '$REMOTE' was not found. Adding: $DEFAULT_REMOTE_URL"
  git remote add "$REMOTE" "$DEFAULT_REMOTE_URL"
fi

if [[ "$RUN_CHECKS" == "1" || "$RUN_CHECKS" == "true" ]]; then
  if [[ -f package.json ]] && command -v npm >/dev/null 2>&1; then
    echo "Running npm checks..."
    npm run check
  fi

  echo "Checking shell scripts..."
  for script in 01_run_sim.sh S1_Start_llm.sh L1_listen_queues.sh L2_listen_llm.sh commit.sh; do
    if [[ -f "$script" ]]; then
      bash -n "$script"
    fi
  done
fi

if [[ -z "$(git status --porcelain)" ]]; then
  echo "No changes to commit."
  exit 0
fi

if [[ "$#" -gt 0 ]]; then
  COMMIT_MESSAGE="$*"
else
  COMMIT_MESSAGE="Update CyberNH project - $(date '+%Y-%m-%d %H:%M:%S')"
fi

echo "Staging all changes..."
git add -A

echo "Committing to $BRANCH..."
git commit -m "$COMMIT_MESSAGE"

echo "Pushing to $REMOTE/$BRANCH..."
if git rev-parse --abbrev-ref --symbolic-full-name "@{u}" >/dev/null 2>&1; then
  git push "$REMOTE" "$BRANCH"
else
  git push -u "$REMOTE" "$BRANCH"
fi

echo "Done."
