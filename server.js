const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const DEFAULT_LLM_DIR = path.join(path.dirname(__dirname), `${path.basename(__dirname)}-LLM`);
const LLM_DIR = process.env.CYBERNH_LLM_DIR || DEFAULT_LLM_DIR;

loadEnvFile(path.join(LLM_DIR, ".env"));
loadEnvFile(path.join(__dirname, "config", "deepseek.env"));
loadEnvFile(path.join(__dirname, "config", "local_deepseek_v4_flash.env"));
loadEnvFile(path.join(__dirname, ".env"));

const { CyberNHSimulation } = require("./src/simulation");
const { loadLlmConfig, publicLlmConfig } = require("./src/llmClient");
const {
  DEFAULT_CONFIG,
  LAYOUT_CONFIG,
  PEAK_WINDOWS,
  CONGESTION_CONFIG,
  SHIFT_CONFIG,
  DEMAND_INTENSITY_CONFIG,
  TASK_CATALOG,
  CARE_MODE_PRIORITY_WEIGHTS,
} = require("./src/config");

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, "public");
const simulation = new CyberNHSimulation();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/ws/sim") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  const unsubscribe = simulation.subscribe((message) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  });

  ws.on("message", async (buffer) => {
    try {
      const message = JSON.parse(buffer.toString());
      const payload = message.payload || {};
      if (message.type === "control.run") simulation.run(payload.config || {});
      if (message.type === "control.pause") simulation.pause();
      if (message.type === "control.stop") simulation.stop();
      if (message.type === "control.step") await simulation.tick();
      if (message.type === "control.reset") simulation.reset(payload.config || {});
      if (message.type === "config.update") simulation.updateConfig(payload);
      if (message.type === "demand.manual_generate") simulation.manualGenerate(payload.count);
      if (message.type === "memory.patch") simulation.patchMemory(payload.agentId, payload.patch || {});
    } catch (error) {
      ws.send(JSON.stringify({ type: "error", payload: { error: error.message } }));
    }
  });

  ws.on("close", unsubscribe);
});

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, version: "cybernh-v3" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/llm/config") {
    sendJson(res, 200, publicLlmConfig(loadLlmConfig({ decisionMode: simulation.getSnapshot().config.agentDecisionMode })));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, {
      defaultConfig: DEFAULT_CONFIG,
      currentConfig: simulation.getSnapshot().config,
      constants: {
        layout: LAYOUT_CONFIG,
        peakWindows: PEAK_WINDOWS,
        congestion: CONGESTION_CONFIG,
        shifts: SHIFT_CONFIG,
        demandIntensity: DEMAND_INTENSITY_CONFIG,
        taskCatalog: TASK_CATALOG,
        careModeWeights: CARE_MODE_PRIORITY_WEIGHTS,
      },
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config") {
    const body = await readJson(req);
    sendJson(res, 200, simulation.updateConfig(body || {}));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/snapshot") {
    sendJson(res, 200, simulation.getSnapshot());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
    const body = await readJson(req);
    sendJson(res, 200, simulation.reset(body?.config || body || {}));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tick") {
    sendJson(res, 200, await simulation.tick());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/run") {
    const body = await readJson(req);
    sendJson(res, 200, simulation.run(body?.config || body || {}));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pause") {
    sendJson(res, 200, simulation.pause());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/stop") {
    sendJson(res, 200, simulation.stop());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/manual-demand") {
    const body = await readJson(req);
    sendJson(res, 200, simulation.manualGenerate(body?.count));
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/memory/")) {
    const agentId = decodeURIComponent(url.pathname.replace("/api/memory/", ""));
    const memory = simulation.getMemory(agentId);
    if (!memory) {
      sendJson(res, 404, { error: "Unknown agent" });
      return;
    }
    sendJson(res, 200, memory);
    return;
  }

  if (req.method === "PATCH" && url.pathname.startsWith("/api/memory/")) {
    const agentId = decodeURIComponent(url.pathname.replace("/api/memory/", ""));
    const body = await readJson(req);
    const memory = simulation.patchMemory(agentId, body || {});
    if (!memory) {
      sendJson(res, 404, { error: "Unknown agent" });
      return;
    }
    sendJson(res, 200, memory);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/decide") {
    const body = await readJson(req);
    const workerId = body?.agentId || body?.workerId;
    const worker = workerId ? simulation.getSnapshot().workers[workerId] : null;
    if (!worker) {
      sendJson(res, 400, { error: "Provide a valid workerId or agentId" });
      return;
    }
    const observation = simulation.getWorkerObservation(workerId);
    sendJson(res, 200, {
      observation,
      llmRequired: simulation.getSnapshot().config.agentDecisionMode !== "rule_only",
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/export/jsonl") {
    sendText(res, 200, simulation.exportJsonl(), "application/x-ndjson; charset=utf-8", "cybernh-events.jsonl");
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/export/metrics.csv") {
    sendText(res, 200, simulation.exportMetricsCsv(), "text/csv; charset=utf-8", "cybernh-metrics.csv");
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendText(res, 404, "Not found", "text/plain; charset=utf-8");
      return;
    }
    res.writeHead(200, { "Content-Type": mimeFor(filePath) });
    res.end(data);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendText(res, status, text, contentType, filename = null) {
  const headers = {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(text),
  };
  if (filename) headers["Content-Disposition"] = `attachment; filename="${filename}"`;
  res.writeHead(status, headers);
  res.end(text);
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cleaned = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equalsIndex = cleaned.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = cleaned.slice(0, equalsIndex).trim();
    let value = cleaned.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

server.listen(PORT, () => {
  console.log(`Cyber-NH dashboard running at http://localhost:${PORT}`);
});
