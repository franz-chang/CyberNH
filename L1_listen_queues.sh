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
STEP_INTERVAL_MS="${WATCH_QUEUE_STEP_INTERVAL_MS:-1000}"
REFRESH_MS="${WATCH_QUEUE_REFRESH_MS:-200}"
SHOW_COMPLETED=0
QUEUE2_LIMIT="${WATCH_QUEUE2_LIMIT:-12}"
ONCE=0
APPEND=0

usage() {
  cat <<'USAGE'
Usage:
  ./L1_listen_queues.sh [options]

Purpose:
  Print real-time Cyber-NH queue contents:
  - Queue1: Senior-Agent Request Queue
  - Queue2: Worker / Assistant Request Queue

Options:
  --url URL              Runtime URL. If omitted, auto-detect an active Cyber-NH runtime.
  --auto                Generate 3 demands and advance ticks automatically
  --auto-step           Advance one tick repeatedly
  --manual-demand N     Generate N manual demands before listening
  --interval MS         Auto-step interval in milliseconds, default: 1000
  --refresh-ms MS       Queue refresh interval in milliseconds, default: 200
  --completed           Include completed Queue1 demands
  --queue2-limit N      Number of recent Queue2 items to print, default: 12
  --append              Append updates instead of clearing and redrawing the terminal
  --once                Print current queues once and exit
  -h, --help            Show this help

Environment:
  CYBERNH_RUNTIME_URL       Runtime URL override
  CYBERNH_WS_URL            WebSocket URL override
  WATCH_LLM_PORT_SCAN       Runtime auto-detect ports, default: 4173-4252
  WATCH_QUEUE2_LIMIT        Recent Queue2 item count
  WATCH_QUEUE_REFRESH_MS    Snapshot polling interval, default: 200
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
    --refresh-ms)
      REFRESH_MS="$2"
      shift 2
      ;;
    --completed|--all)
      SHOW_COMPLETED=1
      shift
      ;;
    --queue2-limit)
      QUEUE2_LIMIT="$2"
      shift 2
      ;;
    --once)
      ONCE=1
      shift
      ;;
    --append)
      APPEND=1
      shift
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
  const activeDemands = (snapshot.queue1?.demands || []).filter((demand) => demand.status !== "completed");
  const running = Boolean(snapshot.control?.running);
  const llmMode = snapshot.config?.agentDecisionMode !== "rule_only";
  const score =
    (running ? 100000 : 0) +
    (llmMode ? 10000 : 0) +
    (activeDemands.length * 1000) +
    (decisions.length * 100) +
    (Number(snapshot.tick || 0) * 10) +
    (url === currentUrl ? 1 : 0);
  candidates.push({
    url,
    score,
    tick: Number(snapshot.tick || 0),
    running,
    mode: snapshot.config?.agentDecisionMode || "unknown",
    activeDemands: activeDemands.length,
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
    .map((candidate) => `${candidate.url} tick=${candidate.tick} running=${candidate.running} mode=${candidate.mode} activeQ1=${candidate.activeDemands} decisions=${candidate.decisions}`)
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

echo "Cyber-NH queue watcher"
echo "Runtime: $RUNTIME_URL"
echo "WebSocket: $WS_URL"
echo "Queue1 completed demands: $([[ "$SHOW_COMPLETED" -eq 1 ]] && echo include || echo hide)"
echo "Queue2 recent limit: $QUEUE2_LIMIT"
echo "Refresh interval: ${REFRESH_MS}ms"
if [[ "$ONCE" -eq 0 ]]; then
  echo "Press Ctrl+C to stop."
fi
echo

WATCH_RUNTIME_URL="$RUNTIME_URL" \
WATCH_WS_URL="$WS_URL" \
WATCH_AUTO_STEP="$AUTO_STEP" \
WATCH_AUTO_DEMAND="$AUTO_DEMAND" \
WATCH_STEP_INTERVAL_MS="$STEP_INTERVAL_MS" \
WATCH_REFRESH_MS="$REFRESH_MS" \
WATCH_SHOW_COMPLETED="$SHOW_COMPLETED" \
WATCH_QUEUE2_LIMIT="$QUEUE2_LIMIT" \
WATCH_ONCE="$ONCE" \
WATCH_APPEND="$APPEND" \
node <<'NODE'
const WebSocket = require("ws");

const runtimeUrl = process.env.WATCH_RUNTIME_URL;
const wsUrl = process.env.WATCH_WS_URL;
const autoStep = process.env.WATCH_AUTO_STEP === "1";
const autoDemand = Number(process.env.WATCH_AUTO_DEMAND || "0");
const stepIntervalMs = Math.max(200, Number(process.env.WATCH_STEP_INTERVAL_MS || "1000"));
const refreshMs = Math.max(200, Number(process.env.WATCH_REFRESH_MS || "200"));
const showCompleted = process.env.WATCH_SHOW_COMPLETED === "1";
const queue2Limit = Math.max(1, Number(process.env.WATCH_QUEUE2_LIMIT || "12"));
const once = process.env.WATCH_ONCE === "1";
const appendMode = process.env.WATCH_APPEND === "1";

let ws = null;
let stepTimer = null;
let refreshTimer = null;
let fetchInFlight = false;
let fetchAgain = false;
let lastSignature = "";

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

function statusCounts(demands) {
  return demands.reduce((acc, demand) => {
    acc[demand.status || "unknown"] = (acc[demand.status || "unknown"] || 0) + 1;
    return acc;
  }, {});
}

function queue1Line(demand) {
  const assigned = (demand.assignedWorkerIds || []).join(",") || "-";
  const arrived = (demand.arrivedWorkerIds || []).join(",") || "-";
  const equip = (demand.requiredEquipment || []).join(",") || "-";
  const wait = demand.waitingTicks ?? 0;
  const remain = demand.remainingServiceTicks ?? "-";
  const score = Number.isFinite(demand.priorityScore) ? demand.priorityScore.toFixed(2) : demand.priorityScore;
  return [
    demand.demandId,
    demand.status,
    `P${demand.priorityLevel}`,
    `score=${score}`,
    `wait=${wait}`,
    `room=${demand.room}`,
    `task=${demand.taskLabelZh || demand.taskKey}`,
    `workers=${assigned}`,
    `arrived=${arrived}`,
    `equip=${equip}`,
    `remain=${remain}`,
    `src=${demand.source || "-"}`,
  ].join(" | ");
}

function queue2Line(item) {
  const kind = item.type || item.action || item.source || "item";
  const agent = item.agentId || item.agent_id || item.workerId || item.decision?.agent_id || "-";
  const decision = item.decision || {};
  const action = decision.action || item.action || "-";
  const target = decision.target_demand_id || item.demandId || item.targetDemandId || "-";
  const reason = decision.reason || item.reason || item.error || "";
  return [
    `tick=${item.tick ?? "-"}`,
    kind,
    `agent=${agent}`,
    `action=${action}`,
    `target=${target}`,
    reason ? `reason=${String(reason).replace(/\s+/g, " ").slice(0, 120)}` : "",
  ].filter(Boolean).join(" | ");
}

function queueSignature(snapshot) {
  const queue1 = snapshot.queue1?.demands || [];
  const queue2 = snapshot.queue2?.items || [];
  return JSON.stringify({
    tick: snapshot.tick,
    q1: queue1.map((demand) => [
      demand.demandId,
      demand.status,
      demand.waitingTicks,
      demand.priorityScore,
      demand.remainingServiceTicks,
      (demand.assignedWorkerIds || []).join(","),
      (demand.arrivedWorkerIds || []).join(","),
    ]),
    q2: queue2.slice(-queue2Limit).map((item) => [
      item.type,
      item.tick,
      item.agentId || item.workerId || item.decision?.agent_id,
      item.demandId || item.decision?.target_demand_id,
      item.action || item.decision?.action,
      item.reason || item.error || item.decision?.reason,
    ]),
  });
}

function renderQueues(snapshot, { force = false } = {}) {
  if (!snapshot) return;
  const signature = queueSignature(snapshot);
  if (!force && signature === lastSignature) return;
  lastSignature = signature;

  const queue1 = snapshot.queue1?.demands || [];
  const visibleQueue1 = showCompleted ? queue1 : queue1.filter((demand) => demand.status !== "completed");
  const queue2 = snapshot.queue2?.items || [];
  const queue2Recent = queue2.slice(-queue2Limit).reverse();
  const counts = statusCounts(queue1);

  if (!appendMode) {
    process.stdout.write("\x1Bc");
  }
  console.log("=".repeat(110));
  console.log(`[${stamp()}] QUEUES tick=${snapshot.tick} time=${snapshot.currentTime} running=${Boolean(snapshot.control?.running)} mode=${snapshot.config?.agentDecisionMode || "-"}`);
  console.log(`Runtime=${runtimeUrl} websocket=${wsUrl} refresh=${refreshMs}ms render=${appendMode ? "append" : "live"}`);
  console.log(`Queue1: total=${queue1.length} visible=${visibleQueue1.length} counts=${JSON.stringify(counts)}`);
  console.log(`Queue2: total=${queue2.length} showing=${queue2Recent.length}`);
  console.log("-".repeat(110));
  console.log(`QUEUE1 ${snapshot.queue1?.id || "Senior-Agent Request Queue"}`);
  if (!visibleQueue1.length) {
    console.log("(empty)");
  } else {
    for (const demand of visibleQueue1) console.log(queue1Line(demand));
  }

  console.log("-".repeat(110));
  console.log(`QUEUE2 ${snapshot.queue2?.id || "Worker / Assistant Request Queue"} recent`);
  if (!queue2Recent.length) {
    console.log("(empty)");
  } else {
    for (const item of queue2Recent) console.log(queue2Line(item));
  }
  console.log("=".repeat(110));
  console.log();
}

async function fetchAndRender({ force = false, reason = "poll" } = {}) {
  if (fetchInFlight) {
    fetchAgain = true;
    return;
  }

  fetchInFlight = true;
  try {
    const snapshot = await request("/api/snapshot");
    renderQueues(snapshot, { force });
  } catch (error) {
    console.error(`queue refresh failed (${reason}): ${error.message}`);
  } finally {
    fetchInFlight = false;
    if (fetchAgain) {
      fetchAgain = false;
      setTimeout(() => fetchAndRender({ reason: "queued" }), 0);
    }
  }
}

let eventRefreshTimer = null;
function scheduleEventRefresh() {
  if (eventRefreshTimer) return;
  eventRefreshTimer = setTimeout(() => {
    eventRefreshTimer = null;
    fetchAndRender({ reason: "event" });
  }, 100);
}

async function handleMessage(buffer) {
  let message;
  try {
    message = JSON.parse(buffer.toString());
  } catch {
    return;
  }

  if (message.type === "snapshot.full" || message.type === "snapshot.patch") {
    renderQueues(message.payload);
    return;
  }

  if (
    message.type === "log.event" ||
    message.type === "agent.memory.updated" ||
    message.type === "agent.decision"
  ) {
    scheduleEventRefresh();
  }
}

async function main() {
  await fetchAndRender({ force: true, reason: "initial" });

  if (once) return;

  if (autoDemand > 0) {
    await request("/api/manual-demand", {
      method: "POST",
      body: JSON.stringify({ count: autoDemand }),
    });
  }

  if (autoStep) {
    stepTimer = setInterval(() => {
      request("/api/tick", { method: "POST", body: "{}" }).catch((error) => {
        console.error(`auto tick failed: ${error.message}`);
      });
    }, stepIntervalMs);
  }

  refreshTimer = setInterval(() => {
    fetchAndRender({ reason: "poll" });
  }, refreshMs);

  ws = new WebSocket(wsUrl);
  ws.on("open", () => {
    fetchAndRender({ reason: "ws-open" });
  });
  ws.on("message", (buffer) => {
    handleMessage(buffer).catch((error) => {
      console.error(`queue watcher error: ${error.message}`);
    });
  });
  ws.on("error", (error) => {
    console.error(`WebSocket error: ${error.message}`);
  });
  ws.on("close", () => {
    if (stepTimer) clearInterval(stepTimer);
    if (refreshTimer) clearInterval(refreshTimer);
    if (eventRefreshTimer) clearTimeout(eventRefreshTimer);
  });
}

process.on("SIGINT", () => {
  if (stepTimer) clearInterval(stepTimer);
  if (refreshTimer) clearInterval(refreshTimer);
  if (eventRefreshTimer) clearTimeout(eventRefreshTimer);
  if (ws) ws.close();
  console.log("\nStopped Cyber-NH queue watcher.");
  process.exit(0);
});

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
