const fs = require("fs");
const path = require("path");

const PROMPT_MODE_ENV = "CYBERNH_SYSTEM_PROMPT_MODE";
const ALIAS_PROMPT_MODES = new Set(["alias", "aliases", "scenario", "scenario_alias", "short"]);
const FULL_PROMPT_MODES = new Set(["full", "legacy", "long"]);
const DEEPSEEK_DECISION_MODE = "deepseek_api";
const LOCAL_DEEPSEEK_V4_FLASH_DECISION_MODE = "local_deepseek_v4_flash";
const LLM_INPUT_FORMAT_ENV = "CYBERNH_LLM_INPUT_FORMAT";
const LLM_INPUT_FORMATS = new Set(["compact", "compact_v2", "compact_v1", "legacy"]);
const WORKER_DECISION_SCHEMA = "WorkerDecisionV1";
const WORKER_DEMAND_FIELDS = [
  "id",
  "room",
  "task",
  "cls",
  "st",
  "care",
  "pl",
  "score",
  "wait",
  "need",
  "assigned",
  "arrived",
  "eq",
  "eq_ok",
  "dist",
  "eta",
  "rel",
];

const ACTIONS = new Set([
  "accept_task",
  "join_two_person_task",
  "reject_all",
  "return_to_station",
  "continue_task",
  "pause_current_task",
  "finish",
]);

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function envBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function normalizedRemoteApiKey(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^(YOUR-CSTCLOUD-API-KEY|sk-your-deepseek-api-key|your-api-key|placeholder)$/i.test(text)) return "";
  return text;
}

function llmInputFormat() {
  const value = String(process.env[LLM_INPUT_FORMAT_ENV] || "compact").trim().toLowerCase();
  if (!LLM_INPUT_FORMATS.has(value)) return "compact_v2";
  return value === "compact" ? "compact_v2" : value;
}

function activeDecisionMode(options = {}) {
  if (options.decisionMode) return String(options.decisionMode);
  if (process.env.CYBERNH_DEFAULT_AGENT_DECISION_MODE) return String(process.env.CYBERNH_DEFAULT_AGENT_DECISION_MODE);
  return "";
}

function isDeepSeekMode(options = {}) {
  if (options.provider) return String(options.provider).toLowerCase() === "deepseek";
  return activeDecisionMode(options) === DEEPSEEK_DECISION_MODE;
}

function isLocalDeepSeekV4FlashMode(options = {}) {
  if (options.provider) return String(options.provider).toLowerCase() === "cstcloud-deepseek";
  return activeDecisionMode(options) === LOCAL_DEEPSEEK_V4_FLASH_DECISION_MODE;
}

function loadLlmConfig(options = {}) {
  if (isDeepSeekMode(options)) {
    return {
      provider: "deepseek",
      providerLabel: "DeepSeek API",
      model: process.env.CYBERNH_DEEPSEEK_MODEL || "deepseek-v4-flash",
      baseUrl: process.env.CYBERNH_DEEPSEEK_BASE_URL || "https://api.deepseek.com",
      apiKey: normalizedRemoteApiKey(process.env.CYBERNH_DEEPSEEK_API_KEY),
      apiKeyEnv: "CYBERNH_DEEPSEEK_API_KEY",
      temperature: envNumber("CYBERNH_DEEPSEEK_TEMPERATURE", 0),
      maxTokens: envNumber("CYBERNH_DEEPSEEK_MAX_TOKENS", 512),
      timeoutSeconds: envNumber("CYBERNH_DEEPSEEK_TIMEOUT_SECONDS", 120),
      jsonMode: envBoolean("CYBERNH_DEEPSEEK_JSON_MODE", true),
      thinking: process.env.CYBERNH_DEEPSEEK_THINKING || "disabled",
      requestMaxTokensKey: "max_tokens",
      forceFullSystemPrompt: true,
      inputFormat: llmInputFormat(),
    };
  }

  if (isLocalDeepSeekV4FlashMode(options)) {
    return {
      provider: "cstcloud-deepseek",
      providerLabel: "CSTCloud DeepSeek-V4-Flash",
      model: process.env.CYBERNH_LOCAL_DEEPSEEK_MODEL || "deepseek-v4-flash",
      baseUrl: process.env.CYBERNH_LOCAL_DEEPSEEK_BASE_URL || "https://uni-api.cstcloud.cn/v1",
      apiKey: normalizedRemoteApiKey(process.env.CYBERNH_LOCAL_DEEPSEEK_API_KEY),
      apiKeyEnv: "CYBERNH_LOCAL_DEEPSEEK_API_KEY",
      temperature: envNumber("CYBERNH_LOCAL_DEEPSEEK_TEMPERATURE", 0),
      maxTokens: envNumber("CYBERNH_LOCAL_DEEPSEEK_MAX_TOKENS", 512),
      timeoutSeconds: envNumber("CYBERNH_LOCAL_DEEPSEEK_TIMEOUT_SECONDS", 120),
      jsonMode: envBoolean("CYBERNH_LOCAL_DEEPSEEK_JSON_MODE", false),
      thinking: envBoolean("CYBERNH_LOCAL_DEEPSEEK_THINKING", false),
      requestMaxTokensKey: "max_length",
      forceFullSystemPrompt: true,
      inputFormat: llmInputFormat(),
    };
  }

  return {
    provider: process.env.CYBERNH_LLM_PROVIDER || "modelscope-transformers",
    providerLabel: "Local Qwen",
    model: process.env.CYBERNH_LLM_MODEL || "qwen3-vl-2b-instruct",
    baseUrl: process.env.CYBERNH_LLM_BASE_URL || "http://localhost:8000/v1",
    apiKey: process.env.CYBERNH_LLM_API_KEY || "EMPTY",
    apiKeyEnv: "CYBERNH_LLM_API_KEY",
    temperature: envNumber("CYBERNH_LLM_TEMPERATURE", 0),
    maxTokens: envNumber("CYBERNH_LLM_MAX_TOKENS", 5096),
    timeoutSeconds: envNumber("CYBERNH_LLM_TIMEOUT_SECONDS", 120),
    jsonMode: envBoolean("CYBERNH_LLM_JSON_MODE", true),
    thinking: null,
    requestMaxTokensKey: "max_tokens",
    forceFullSystemPrompt: false,
    inputFormat: llmInputFormat(),
  };
}

async function decideWorkerWithLlm(observation, options = {}) {
  const cfg = loadLlmConfig(options);
  const requestPayload = buildRequestPayload(cfg, observation);

  try {
    const first = await completeOnce(cfg, requestPayload);
    if (!first.ok) return { ...first, config: publicConfig(cfg), requestPayload };

    let content = first.content;
    let completion = first.completion;
    let decision;
    try {
      decision = parseDecisionContent(content, observation);
    } catch (validationError) {
      const retryPayload = buildRepairRequestPayload(cfg, observation, requestPayload, content, validationError.message);
      const retry = await completeOnce(cfg, retryPayload);
      if (!retry.ok) return { ...retry, config: publicConfig(cfg), requestPayload: retryPayload };
      content = retry.content;
      completion = retry.completion;
      decision = parseDecisionContent(content, observation);
      return {
        ok: true,
        config: publicConfig(cfg),
        requestPayload: retryPayload,
        rawReply: completion,
        content,
        decision,
        repaired: true,
        repairReason: validationError.message,
      };
    }
    return {
      ok: true,
      config: publicConfig(cfg),
      requestPayload,
      rawReply: completion,
      content,
      decision,
    };
  } catch (error) {
    return {
      ok: false,
      config: publicConfig(cfg),
      requestPayload,
      rawReply: null,
      error: error.name === "AbortError" ? `LLM request timed out after ${cfg.timeoutSeconds}s` : error.message,
    };
  }
}

async function completeOnce(cfg, requestPayload) {
  if (cfg.apiKeyEnv && !cfg.apiKey) {
    let configHint = "";
    if (cfg.provider === "cstcloud-deepseek") {
      configHint = "; edit config/local_deepseek_v4_flash.env and replace the placeholder API key";
    } else if (cfg.provider === "deepseek") {
      configHint = "; edit config/deepseek.env and set a real API key";
    }
    return {
      ok: false,
      rawReply: null,
      error: `${cfg.apiKeyEnv} is missing or still a placeholder for ${cfg.providerLabel || cfg.provider} mode${configHint}`,
    };
  }

  const endpoint = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, cfg.timeoutSeconds) * 1000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(requestPayload),
    });

    const responseText = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        rawReply: responseText,
        error: describeHttpError(cfg, response.status),
      };
    }

    const completion = JSON.parse(responseText);
    return {
      ok: true,
      completion,
      content: completion?.choices?.[0]?.message?.content || "",
    };
  } catch (error) {
    return {
      ok: false,
      rawReply: null,
      error: describeRequestError(cfg, error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function describeHttpError(cfg, status) {
  if (cfg.provider === "deepseek" && status === 401) {
    return "DeepSeek API returned 401 Unauthorized; check CYBERNH_DEEPSEEK_API_KEY";
  }
  if (cfg.provider === "cstcloud-deepseek" && status === 401) {
    return "CSTCloud DeepSeek-V4-Flash returned 401 Unauthorized; check CYBERNH_LOCAL_DEEPSEEK_API_KEY";
  }
  if (cfg.provider !== "deepseek" && status === 401) {
    return "Local Qwen endpoint returned 401; check CYBERNH_LLM_API_KEY matches the running LLM server";
  }
  return `LLM endpoint returned ${status}`;
}

function describeRequestError(cfg, error) {
  if (error.name === "AbortError") return `LLM request timed out after ${cfg.timeoutSeconds}s`;
  const code = error.cause?.code || error.code || "";
  if (cfg.provider === "modelscope-transformers" && (code === "ECONNREFUSED" || error.message === "fetch failed")) {
    return `Local Qwen endpoint is not reachable at ${cfg.baseUrl}; start it with ./S1_Start_llm.sh or ./01_run_sim.sh`;
  }
  if (cfg.provider === "deepseek" && (code === "ECONNREFUSED" || error.message === "fetch failed")) {
    return `DeepSeek API endpoint is not reachable at ${cfg.baseUrl}`;
  }
  if (cfg.provider === "cstcloud-deepseek" && (code === "ECONNREFUSED" || error.message === "fetch failed")) {
    return `CSTCloud DeepSeek-V4-Flash endpoint is not reachable at ${cfg.baseUrl}`;
  }
  return error.message;
}

function buildRequestPayload(cfg, observation) {
  const userPayload = workerUserPayload(cfg, observation);
  const messages = [
    {
      role: "system",
      content: loadWorkerSystemPrompt(observation.agentId, cfg),
    },
    {
      role: "user",
      content: stringifyUserContent(userPayload, cfg),
    },
  ];
  const payload = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
  };
  payload[cfg.requestMaxTokensKey || "max_tokens"] = cfg.maxTokens;
  if (cfg.jsonMode) payload.response_format = { type: "json_object" };
  if (cfg.provider === "deepseek" && cfg.thinking && cfg.thinking !== "default") {
    payload.thinking = { type: cfg.thinking };
  }
  if (cfg.provider === "cstcloud-deepseek" && cfg.thinking) {
    payload.chat_template_kwargs = { thinking: true };
  }
  return payload;
}

function buildRepairRequestPayload(cfg, observation, originalPayload, invalidContent, validationError) {
  const allowedTargetIds = (observation.candidateDemands || []).map((demand) => demand.demandId);
  const compactInput = cfg.inputFormat !== "legacy";
  const compactV2 = cfg.inputFormat === "compact_v2";
  const repairPayload = {
    instruction: compactV2 ? undefined : "Previous JSON was invalid. Return one corrected WorkerDecision JSON object only.",
    schema: compactV2 ? WORKER_DECISION_SCHEMA : undefined,
    repair: compactV2 ? "invalid_json" : undefined,
    aid: compactV2 ? observation.agentId : undefined,
    validation_error: validationError,
    output_schema: compactV2 ? undefined : compactInput ? compactWorkerDecisionSchema(observation) : workerDecisionSchema(observation),
  };
  if (allowedTargetIds.length === 0) {
    repairPayload.required_when_no_allowed_targets = { action: "reject_all", target_demand_id: null };
  }
  repairPayload[compactV2 ? "allowed_targets" : "allowed_target_demand_ids"] = compactV2
    ? [...allowedTargetIds, null]
    : allowedTargetIds;
  return {
    ...originalPayload,
    messages: [
      ...originalPayload.messages,
      { role: "assistant", content: invalidContent || "{}" },
      {
        role: "user",
        content: stringifyUserContent(repairPayload, cfg),
      },
    ],
  };
}

function workerUserPayload(cfg, observation) {
  if (cfg.inputFormat === "legacy") {
    const llmObservation = prepareWorkerObservationForLlm(observation, { compact: false });
    return legacyWorkerUserPayload(cfg, observation, llmObservation);
  }
  if (cfg.inputFormat === "compact_v1") {
    const llmObservation = prepareWorkerObservationForLlm(observation, { compact: true });
    return compactWorkerUserPayloadV1(observation, llmObservation);
  }
  return compactWorkerUserPayloadV2(observation);
}

function legacyWorkerUserPayload(cfg, observation, llmObservation) {
  return {
    instruction: "Return one valid JSON object only. No markdown. No chain-of-thought.",
    output_schema: workerDecisionSchema(observation),
    important: workerInputRules(),
    allowed_target_demand_ids: (llmObservation.candidateDemands || []).map((demand) => demand.demandId),
    metadata: {
      provider: cfg.provider,
      prompt_mode: cfg.forceFullSystemPrompt ? "full_system_prompt" : "configured",
    },
    observation: llmObservation,
  };
}

function compactWorkerUserPayloadV1(observation, llmObservation) {
  return {
    instruction: "Return one valid JSON object only. No markdown. No chain-of-thought.",
    output_schema: compactWorkerDecisionSchema(observation),
    important: workerInputRules({ compact: true }),
    observation: llmObservation,
  };
}

function compactWorkerUserPayloadV2(observation) {
  const memory = observation.workerMemory || {};
  const publicMemory = memory.publicMemory || {};
  const queue = memory.taskQueue || {};
  const env = memory.envMemory || {};
  const exp = memory.expMemory || {};
  const panel = observation.panelState || {};
  const currentTask = observation.currentTask || {};
  const status = publicMemory.status ?? observation.status;
  const fatigue = publicMemory.fatigue ?? observation.fatigue;
  const state = compactObject({
    wing: publicMemory.wing,
    tile: compactTile(publicMemory.currentTile),
    status,
    fatigue,
    speed: publicMemory.effectiveSpeedMPerMin,
    current: publicMemory.currentTaskId ?? currentTask.demandId,
    current_cls: currentTask.taskClass,
    current_remaining: currentTask.remainingServiceTicks,
    done_count: publicMemory.completedTaskCount ?? countItems(queue.done),
    walk_m: publicMemory.totalWalkingDistanceM,
    service_ticks: publicMemory.totalServiceTicks,
    queue: compactObject({
      todo: queue.todo,
      doing: queue.doing,
      done_count: countItems(queue.done),
      paused_count: countItems(queue.paused),
      abandoned_count: countItems(queue.abandoned),
    }),
  });

  return compactObject({
    schema: WORKER_DECISION_SCHEMA,
    aid: observation.agentId,
    tick: observation.tick,
    time: observation.currentTime,
    mode: observation.careMode,
    sim: compactObject({
      duration: panel.durationTicks,
      days: panel.simulationDays,
      total: panel.totalDurationTicks,
    }),
    state,
    constraints: compactConstraints(observation.constraints || {}, status),
    eq: env.knownEquipment,
    congestion: env.congestedAreas,
    nearby: env.nearbyPendingDemands,
    stable_seniors: exp.stableSeniorIds,
    prefs: exp.learnedPreferenceTags,
    recent_reasons: exp.recentDecisionReasons,
    demand_fields: WORKER_DEMAND_FIELDS,
    demands: (observation.candidateDemands || []).map(compactDemandRow),
    allowed_targets: allowedTargetIds(observation),
  });
}

function compactConstraints(constraints, status) {
  const unavailable = constraints.unavailable ?? (status === undefined ? undefined : status === "unavailable");
  const accept = constraints.canAcceptNewTask ?? (status === undefined ? undefined : status === "idle" && !unavailable);
  return compactObject({
    accept,
    preempt: constraints.canPreemptCurrentTask,
    fatigue_warn: constraints.fatigueWarning,
    unavailable,
  });
}

function compactDemandRow(demand) {
  return [
    demand.demandId ?? null,
    demand.room ?? null,
    demand.taskLabelZh ?? null,
    demand.taskClass ?? null,
    demand.status ?? null,
    demand.seniorCareLevel ?? null,
    demand.priorityLevel ?? null,
    demand.priorityScore ?? null,
    demand.waitingTicks ?? null,
    demand.requiredWorkers ?? null,
    demand.assignedWorkerIds || [],
    demand.arrivedWorkerIds || [],
    demand.requiredEquipment || [],
    demand.equipmentAvailable ?? null,
    demand.routeDistanceM ?? demand.distanceM ?? null,
    demand.estimatedArrivalTicks ?? null,
    demand.stableRelation ?? null,
  ];
}

function allowedTargetIds(observation) {
  return [...(observation.candidateDemands || []).map((demand) => demand.demandId).filter(Boolean), null];
}

function compactTile(tile) {
  if (tile && typeof tile === "object" && "x" in tile && "y" in tile) return [tile.x, tile.y];
  return tile;
}

function countItems(value) {
  return Array.isArray(value) ? value.length : 0;
}

function compactObject(payload) {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => {
      if (value === undefined || value === null) return false;
      if (Array.isArray(value) && value.length === 0) return false;
      if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return false;
      return true;
    })
  );
}

function workerInputRules({ compact = false } = {}) {
  if (compact) {
    return [
      "Use exactly output_schema.required; action key is required; do not use decision/task/command/status.",
      "agent_id must equal observation.agentId.",
      "Only observation.candidateDemands[].demandId is assignable; broadcastBoard, workerMemory, done/waiting IDs are context only.",
      "For accept_task/join_two_person_task, target_demand_id must be in output_schema.fields.target_demand_id.",
      "If no suitable candidate, use action=reject_all and target_demand_id=null.",
    ];
  }
  return [
    "Use exactly these keys: agent_id, action, target_demand_id, reason, confidence, memory_update.",
    "The action key is required. Do not use decision, task, command, or status instead of action.",
    "agent_id must equal the observation.agentId.",
    "Only observation.candidateDemands is assignable. Ignore any demand IDs not listed there.",
    "If action is accept_task or join_two_person_task, target_demand_id must be one of observation.candidateDemands[].demandId.",
    "If no candidate demand is suitable, use action=reject_all and target_demand_id=null.",
  ];
}

function stringifyUserContent(payload, cfg = {}) {
  return cfg.inputFormat === "legacy" ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
}

function prepareWorkerObservationForLlm(observation, options = {}) {
  const llmObservation = JSON.parse(JSON.stringify(observation));
  const candidateIds = (llmObservation.candidateDemands || []).map((demand) => demand.demandId);
  if (!options.compact) llmObservation.legalCandidateDemandIds = candidateIds;
  llmObservation.decisionProtocol = {
    assignableDemandSource: options.compact ? "candidateDemands" : "candidateDemands only",
    forbiddenTargetSources: ["broadcastBoard", "workerMemory", "completedDemandIds", "waitingDemandIds"],
    noCandidateAction: "reject_all",
  };
  llmObservation.broadcastBoard = {
    note: options.compact
      ? "context_only_not_legal_targets"
      : "Informational only. Demand IDs from the broadcast board are not legal targets unless they also appear in candidateDemands.",
  };
  return llmObservation;
}

function parseDecisionContent(content, observation) {
  return normalizeDecision(JSON.parse(extractJsonObject(stripJsonFence(content))), observation);
}

function loadWorkerSystemPrompt(agentId, cfg = {}) {
  const alias = cfg.forceFullSystemPrompt ? null : loadScenarioPromptAlias("Worker-Agent");
  if (alias) return alias;

  const promptPath = path.join(__dirname, "..", "runtime", "prompts", "worker_agent.system.md");
  try {
    return fs.readFileSync(promptPath, "utf8").replaceAll("{{AGENT_ID}}", agentId);
  } catch {
    return `You are Worker-Agent ${agentId}. Return one valid WorkerDecision JSON object only.`;
  }
}

function loadScenarioPromptAlias(agentType) {
  const promptMode = String(process.env[PROMPT_MODE_ENV] || "scenario_alias").trim().toLowerCase();
  if (FULL_PROMPT_MODES.has(promptMode)) return null;
  if (!ALIAS_PROMPT_MODES.has(promptMode)) return null;

  const aliasPath = path.join(__dirname, "..", "runtime", "prompts", "scenario_aliases.json");
  try {
    const payload = JSON.parse(fs.readFileSync(aliasPath, "utf8"));
    return payload?.aliases?.[agentType]?.scenario || null;
  } catch {
    return null;
  }
}

function normalizeDecision(decision, observation) {
  decision = coerceDecisionShape(decision, observation);
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    throw new Error("LLM reply is not a JSON object");
  }
  if (!decision.agent_id) {
    throw new Error("LLM reply is missing agent_id");
  }
  if (!decision.action) {
    throw new Error("LLM reply is missing action");
  }
  const normalized = {
    agent_id: String(decision.agent_id),
    action: String(decision.action),
    target_demand_id: decision.target_demand_id ?? null,
    reason: String(decision.reason || "LLM decision"),
    confidence: Number(decision.confidence ?? 0.5),
    memory_update: decision.memory_update && typeof decision.memory_update === "object" && !Array.isArray(decision.memory_update)
      ? decision.memory_update
      : {},
  };

  if (normalized.agent_id !== observation.agentId) {
    throw new Error(`LLM selected unexpected agent_id ${normalized.agent_id}`);
  }
  if (!ACTIONS.has(normalized.action)) {
    throw new Error(`Unsupported LLM action ${normalized.action}`);
  }
  validateTargetDemand(normalized, observation);
  if (!Number.isFinite(normalized.confidence)) normalized.confidence = 0.5;
  normalized.confidence = Math.max(0, Math.min(1, normalized.confidence));

  return normalized;
}

function workerDecisionSchema(observation) {
  const agentId = observation.agentId;
  const targetIds = (observation.candidateDemands || []).map((demand) => demand.demandId);
  return {
    type: "object",
    required: ["agent_id", "action", "target_demand_id", "reason", "confidence", "memory_update"],
    additionalProperties: false,
    properties: {
      agent_id: { const: agentId },
      action: { enum: [...ACTIONS] },
      target_demand_id: { enum: [...targetIds, null] },
      reason: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      memory_update: { type: "object" },
    },
    example: {
      agent_id: agentId,
      action: "accept_task",
      target_demand_id: "Q001",
      reason: "距离近且设备可用",
      confidence: 0.82,
      memory_update: {},
    },
  };
}

function compactWorkerDecisionSchema(observation) {
  const agentId = observation.agentId;
  const targetIds = (observation.candidateDemands || []).map((demand) => demand.demandId);
  return {
    required: ["agent_id", "action", "target_demand_id", "reason", "confidence", "memory_update"],
    no_extra_keys: true,
    fields: {
      agent_id: { const: agentId },
      action: [...ACTIONS],
      target_demand_id: [...targetIds, null],
      reason: "string",
      confidence: "number[0,1]",
      memory_update: "object",
    },
  };
}

function coerceDecisionShape(decision, observation) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return decision;

  const shaped = { ...decision };
  if (!shaped.agent_id) shaped.agent_id = shaped.agentId || shaped.worker_id || shaped.workerId;
  if (!shaped.action) shaped.action = shaped.decision || shaped.command || shaped.intent;
  if (shaped.target_demand_id === undefined) {
    shaped.target_demand_id =
      shaped.targetDemandId ??
      shaped.demand_id ??
      shaped.demandId ??
      shaped.task_id ??
      shaped.taskId ??
      shaped.memory_update?.task_id ??
      shaped.memory_update?.demandId;
  }
  if (!shaped.reason && shaped.rationale) shaped.reason = shaped.rationale;
  if (!shaped.memory_update && shaped.memoryUpdate) shaped.memory_update = shaped.memoryUpdate;

  if (!shaped.agent_id && shaped.action) shaped.agent_id = observation.agentId;
  return shaped;
}

function validateTargetDemand(decision, observation) {
  const candidateIds = new Set((observation.candidateDemands || []).map((demand) => demand.demandId));
  if (decision.target_demand_id && !candidateIds.has(decision.target_demand_id)) {
    throw new Error(`LLM selected target_demand_id ${decision.target_demand_id} outside candidateDemands`);
  }
  if ((decision.action === "accept_task" || decision.action === "join_two_person_task") && !decision.target_demand_id) {
    throw new Error(`LLM action ${decision.action} requires target_demand_id`);
  }
}

function stripJsonFence(text) {
  let stripped = String(text || "").trim();
  if (stripped.startsWith("```")) {
    stripped = stripped.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  }
  return stripped;
}

function extractJsonObject(text) {
  const source = String(text || "").trim();
  if (!source) return source;
  if (source.startsWith("{")) return source;

  const start = source.indexOf("{");
  if (start < 0) return source;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return source;
}

function publicConfig(cfg) {
  return {
    provider: cfg.provider,
    providerLabel: cfg.providerLabel,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    apiKeyConfigured: Boolean(cfg.apiKey),
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    timeoutSeconds: cfg.timeoutSeconds,
    jsonMode: cfg.jsonMode,
    thinking: cfg.thinking,
    promptMode: cfg.forceFullSystemPrompt ? "full_system_prompt" : "configured",
    inputFormat: cfg.inputFormat,
  };
}

module.exports = {
  decideWorkerWithLlm,
  loadLlmConfig,
  publicLlmConfig: publicConfig,
  DEEPSEEK_DECISION_MODE,
  LOCAL_DEEPSEEK_V4_FLASH_DECISION_MODE,
};
