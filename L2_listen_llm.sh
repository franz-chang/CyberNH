#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"
DEFAULT_LLM_DIR="$(cd "$ROOT_DIR/.." && pwd)/$(basename "$ROOT_DIR")-LLM"
LLM_DIR="${CYBERNH_LLM_DIR:-$DEFAULT_LLM_DIR}"
export CYBERNH_LLM_DIR="$LLM_DIR"

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

PORT="${PORT:-4173}"
RUNTIME_URL="${CYBERNH_RUNTIME_URL:-http://localhost:${PORT}}"
RUNTIME_URL="${RUNTIME_URL%/}"
RUNTIME_URL_EXPLICIT=0
if [[ -n "${CYBERNH_RUNTIME_URL:-}" ]]; then
  RUNTIME_URL_EXPLICIT=1
fi
WS_URL="${CYBERNH_WS_URL:-}"
AUTO_STEP=0
AUTO_DEMAND=0
STEP_INTERVAL_MS="${WATCH_LLM_STEP_INTERVAL_MS:-1000}"

usage() {
  cat <<'USAGE'
Usage:
  ./L2_listen_llm.sh [options]

Purpose:
  Only print real-time LLM input and LLM reply blocks.
  It does not print task logs, queue summaries, metrics, or map events.

Options:
  --url URL              Runtime URL. If omitted, auto-detect an active Cyber-NH runtime.
  --auto                Generate 3 demands and advance ticks automatically
  --auto-step           Advance one tick repeatedly
  --manual-demand N     Generate N manual demands before listening
  --interval MS         Auto-step interval in milliseconds, default: 1000
  -h, --help            Show this help

Environment:
  CYBERNH_RUNTIME_URL       Runtime URL override
  CYBERNH_WS_URL            WebSocket URL override
  CYBERNH_LLM_PROVIDER      Displayed in the decision header
  CYBERNH_LLM_MODEL         Displayed in the decision header
  CYBERNH_LLM_BASE_URL      Displayed in the decision header

Note:
  If the LLM endpoint is down or returns invalid JSON, Cyber-NH prints the
  attempted LLM request and the failure. In LLM mode, the simulator does not
  apply a rule replacement.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
  --url)
      RUNTIME_URL="${2%/}"
      RUNTIME_URL_EXPLICIT=1
      shift 2
      ;;
    --auto)
      AUTO_STEP=1
      AUTO_DEMAND=3
      shift
      ;;
    --auto-step)
      AUTO_STEP=1
      shift
      ;;
    --manual-demand)
      AUTO_DEMAND="$2"
      shift 2
      ;;
    --interval)
      STEP_INTERVAL_MS="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

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

if [[ ! -d node_modules/ws ]]; then
  echo "Installing project dependencies..."
  npm install
fi

discover_runtime_url() {
  WATCH_CURRENT_RUNTIME_URL="$RUNTIME_URL" node <<'NODE'
const currentUrl = process.env.WATCH_CURRENT_RUNTIME_URL || "http://localhost:4173";
const scanSpec = process.env.WATCH_LLM_PORT_SCAN || "4173-4252";

function parsePorts(spec) {
  const ports = new Set();
  for (const part of spec.split(",")) {
    const item = part.trim();
    if (!item) continue;
    const range = item.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      for (let port = start; port <= end; port += 1) ports.add(port);
      continue;
    }
    const port = Number(item);
    if (Number.isInteger(port)) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 700);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const candidates = [];
for (const port of parsePorts(scanSpec)) {
  const url = `http://localhost:${port}`;
  const health = await getJson(`${url}/api/health`);
  if (!health?.ok) continue;
  const snapshot = await getJson(`${url}/api/snapshot`);
  if (!snapshot) continue;
  const decisions = (snapshot.eventLog || []).filter((event) => event.type === "agent.decision");
  const llmDecisions = decisions.filter((event) => event.payload?.source && event.payload.source !== "LLM_ERROR");
  const running = Boolean(snapshot.control?.running);
  const llmMode = snapshot.config?.agentDecisionMode !== "rule_only";
  const score =
    (running ? 100000 : 0) +
    (llmMode ? 10000 : 0) +
    (llmDecisions.length * 100) +
    (Number(snapshot.tick || 0) * 10) +
    (url === currentUrl ? 1 : 0);
  candidates.push({
    url,
    score,
    tick: Number(snapshot.tick || 0),
    running,
    mode: snapshot.config?.agentDecisionMode || "unknown",
    decisions: decisions.length,
  });
}

if (!candidates.length) {
  console.log(currentUrl);
  process.exit(0);
}

candidates.sort((a, b) => b.score - a.score || b.tick - a.tick);
const best = candidates[0];
if (best.url !== currentUrl || candidates.length > 1) {
  const summary = candidates
    .slice(0, 5)
    .map((candidate) => `${candidate.url} tick=${candidate.tick} running=${candidate.running} mode=${candidate.mode} decisions=${candidate.decisions}`)
    .join("; ");
  console.error(`Auto-selected runtime: ${best.url}`);
  console.error(`Discovered runtimes: ${summary}`);
}
console.log(best.url);
NODE
}

if [[ "$RUNTIME_URL_EXPLICIT" -eq 0 ]]; then
  RUNTIME_URL="$(discover_runtime_url)"
  RUNTIME_URL="${RUNTIME_URL%/}"
fi

if [[ -z "$WS_URL" ]]; then
  if [[ "$RUNTIME_URL" == https://* ]]; then
    WS_URL="wss://${RUNTIME_URL#https://}/ws/sim"
  else
    WS_URL="ws://${RUNTIME_URL#http://}/ws/sim"
  fi
fi

if ! curl -fsS --max-time 2 "$RUNTIME_URL/api/health" >/dev/null; then
  echo "Cyber-NH runtime is not reachable at $RUNTIME_URL"
  echo "Start it first with: ./01_run_sim.sh"
  exit 1
fi

echo "Cyber-NH LLM I/O watcher"
echo "Runtime: $RUNTIME_URL"
echo "WebSocket: $WS_URL"
echo "Only LLM input/reply blocks will be printed."
echo "Press Ctrl+C to stop."
echo

WATCH_RUNTIME_URL="$RUNTIME_URL" \
WATCH_WS_URL="$WS_URL" \
WATCH_AUTO_STEP="$AUTO_STEP" \
WATCH_AUTO_DEMAND="$AUTO_DEMAND" \
WATCH_STEP_INTERVAL_MS="$STEP_INTERVAL_MS" \
WATCH_LLM_PROVIDER="${CYBERNH_LLM_PROVIDER:-modelscope-transformers}" \
WATCH_LLM_MODEL="${CYBERNH_LLM_MODEL:-qwen3-vl-2b-instruct}" \
WATCH_LLM_BASE_URL="${CYBERNH_LLM_BASE_URL:-http://localhost:8000/v1}" \
node <<'NODE'
const WebSocket = require("ws");

const runtimeUrl = process.env.WATCH_RUNTIME_URL;
const wsUrl = process.env.WATCH_WS_URL;
const autoStep = process.env.WATCH_AUTO_STEP === "1";
const autoDemand = Number(process.env.WATCH_AUTO_DEMAND || "0");
const stepIntervalMs = Math.max(200, Number(process.env.WATCH_STEP_INTERVAL_MS || "1000"));
const llmProvider = process.env.WATCH_LLM_PROVIDER;
const llmModel = process.env.WATCH_LLM_MODEL;
const llmBaseUrl = process.env.WATCH_LLM_BASE_URL;

const seenEvents = new Set();
let ws = null;
let stepTimer = null;

async function request(path, options = {}) {
  const response = await fetch(`${runtimeUrl}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${path} failed: ${response.status} ${text}`);
  }
  return response.json();
}

function stamp() {
  return new Date().toISOString();
}

function stableJson(value) {
  return JSON.stringify(value ?? null, null, 2);
}

function printIoBlock({ event, input, reply, source, note }) {
  const payload = event.payload || {};
  const llmConfig = payload.llmConfig || {};
  const decision = reply || payload.llmReply || payload.decision || payload.rawReply || payload.response || null;
  const agentId = decision?.agent_id || payload.agent_id || payload.agentId || input?.agentId || "unknown";
  const target = decision?.target_demand_id || "-";
  const action = decision?.action || "-";
  const tick = event.tick ?? payload.tick ?? input?.tick ?? "-";

  console.log("=".repeat(96));
  console.log(`[${stamp()}] LLM I/O tick=${tick} agent=${agentId} source=${source}`);
  console.log(`provider=${llmConfig.provider || llmProvider} model=${llmConfig.model || llmModel} base_url=${llmConfig.baseUrl || llmBaseUrl}`);
  console.log(`reply_summary action=${action} target=${target}`);
  if (note) console.log(`note=${note}`);
  console.log("-".repeat(96));
  console.log("LLM INPUT");
  console.log(stableJson(input));
  console.log("-".repeat(96));
  console.log("LLM REPLY");
  console.log(stableJson(decision));
  console.log("=".repeat(96));
  console.log();
}

async function runtimeIoFromEvent(event) {
  const payload = event.payload || {};
  const decision = payload.decision || {};
  const agentId = decision.agent_id || payload.agent_id || payload.agentId;
  if (!agentId) return { input: null, reply: decision || null, note: "event did not include an agent id" };
  try {
    const result = await request("/api/agent/decide", {
      method: "POST",
      body: JSON.stringify({ agentId }),
    });
    return {
      input: result.observation || null,
      reply: payload.llmReply || payload.decision || null,
      note: "input was fetched from /api/agent/decide because this event did not include llmInput",
    };
  } catch (error) {
    return {
      input: null,
      reply: payload.llmReply || payload.decision || null,
      note: `failed to fetch observation: ${error.message}`,
    };
  }
}

async function renderDecisionEvent(event) {
  if (!event || !event.id || seenEvents.has(event.id)) return;
  seenEvents.add(event.id);
  if (event.type !== "agent.decision") return;

  const payload = event.payload || {};
  const source = payload.source || "LLM";
  let input = payload.llmInput || payload.input || payload.observation || null;
  let reply = payload.llmReply || payload.rawReply || payload.response || payload.decision || null;
  let note = payload.llmError
    ? `LLM failed or was rejected: ${payload.llmError}`
    : "";

  if (!reply && payload.llmError) {
    reply = {
      error: payload.llmError,
    };
  }

  if (!input || !reply) {
    const runtimeIo = await runtimeIoFromEvent(event);
    input ||= runtimeIo.input;
    reply ||= runtimeIo.reply;
    note = note ? `${note}; ${runtimeIo.note}` : runtimeIo.note;
  }

  printIoBlock({ event, input, reply, source, note });
}

async function handleMessage(buffer) {
  let message;
  try {
    message = JSON.parse(buffer.toString());
  } catch {
    return;
  }

  if (message.type === "log.event") {
    await renderDecisionEvent(message.payload);
    return;
  }

  if (message.type === "snapshot.full" || message.type === "snapshot.patch") {
    const events = [...(message.payload?.eventLog || [])].reverse();
    for (const event of events) await renderDecisionEvent(event);
    return;
  }

  if (message.type === "agent.decision") {
    await renderDecisionEvent({
      id: `ws:${Date.now()}:${Math.random()}`,
      type: "agent.decision",
      tick: message.payload?.tick,
      payload: message.payload,
    });
  }
}

async function main() {
  const snapshot = await request("/api/snapshot");
  for (const event of snapshot.eventLog || []) {
    if (event?.id) seenEvents.add(event.id);
  }

  if (autoDemand > 0) {
    await request("/api/manual-demand", {
      method: "POST",
      body: JSON.stringify({ count: autoDemand }),
    });
  }

  if (autoStep) {
    stepTimer = setInterval(() => {
      request("/api/tick", { method: "POST", body: "{}" }).catch(() => {});
    }, stepIntervalMs);
  }

  ws = new WebSocket(wsUrl);
  ws.on("message", (buffer) => {
    handleMessage(buffer).catch((error) => {
      console.error(`LLM watcher error: ${error.message}`);
    });
  });
  ws.on("error", (error) => {
    console.error(`WebSocket error: ${error.message}`);
  });
  ws.on("close", () => {
    if (stepTimer) clearInterval(stepTimer);
  });
}

process.on("SIGINT", () => {
  if (stepTimer) clearInterval(stepTimer);
  if (ws) ws.close();
  console.log("\nStopped Cyber-NH LLM I/O watcher.");
  process.exit(0);
});

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
