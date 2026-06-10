const fs = require("fs");
const path = require("path");

const PROMPT_MODE_ENV = "CYBERNH_SYSTEM_PROMPT_MODE";
const ALIAS_PROMPT_MODES = new Set(["alias", "aliases", "scenario", "scenario_alias", "short"]);
const FULL_PROMPT_MODES = new Set(["full", "legacy", "long"]);

const ACTIONS = new Set([
  "accept_task",
  "join_two_person_task",
  "reject_all",
  "return_to_station",
  "continue_task",
  "pause_current_task",
  "finish",
]);

function loadLlmConfig() {
  return {
    provider: process.env.CYBERNH_LLM_PROVIDER || "modelscope-transformers",
    model: process.env.CYBERNH_LLM_MODEL || "qwen3-vl-2b-instruct",
    baseUrl: process.env.CYBERNH_LLM_BASE_URL || "http://localhost:8000/v1",
    apiKey: process.env.CYBERNH_LLM_API_KEY || "EMPTY",
    temperature: Number(process.env.CYBERNH_LLM_TEMPERATURE || "0"),
    maxTokens: Number(process.env.CYBERNH_LLM_MAX_TOKENS || "512"),
    timeoutSeconds: Number(process.env.CYBERNH_LLM_TIMEOUT_SECONDS || "120"),
    jsonMode: String(process.env.CYBERNH_LLM_JSON_MODE || "true").toLowerCase() === "true",
  };
}

async function decideWorkerWithLlm(observation) {
  const cfg = loadLlmConfig();
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
        error: `LLM endpoint returned ${response.status}`,
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
      error: error.name === "AbortError" ? `LLM request timed out after ${cfg.timeoutSeconds}s` : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildRequestPayload(cfg, observation) {
  const llmObservation = prepareWorkerObservationForLlm(observation);
  const messages = [
    {
      role: "system",
      content: loadWorkerSystemPrompt(observation.agentId),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          instruction: "Return one valid JSON object only. No markdown. No chain-of-thought.",
          output_schema: workerDecisionSchema(observation),
          important: [
            "Use exactly these keys: agent_id, action, target_demand_id, reason, confidence, memory_update.",
            "The action key is required. Do not use decision, task, command, or status instead of action.",
            "agent_id must equal the observation.agentId.",
            "Only observation.candidateDemands is assignable. Ignore any demand IDs not listed there.",
            "If action is accept_task or join_two_person_task, target_demand_id must be one of observation.candidateDemands[].demandId.",
            "If no candidate demand is suitable, use action=reject_all and target_demand_id=null.",
          ],
          allowed_target_demand_ids: (llmObservation.candidateDemands || []).map((demand) => demand.demandId),
          observation: llmObservation,
        },
        null,
        2
      ),
    },
  ];
  const payload = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens,
  };
  if (cfg.jsonMode) payload.response_format = { type: "json_object" };
  return payload;
}

function buildRepairRequestPayload(cfg, observation, originalPayload, invalidContent, validationError) {
  const allowedTargetIds = (observation.candidateDemands || []).map((demand) => demand.demandId);
  return {
    ...originalPayload,
    messages: [
      ...originalPayload.messages,
      { role: "assistant", content: invalidContent || "{}" },
      {
        role: "user",
        content: JSON.stringify(
          {
            instruction: "Your previous JSON was invalid for Cyber-NH. Return one corrected WorkerDecision JSON object only.",
            validation_error: validationError,
            allowed_target_demand_ids: allowedTargetIds,
            required_when_no_allowed_targets: allowedTargetIds.length === 0
              ? { action: "reject_all", target_demand_id: null }
              : undefined,
            output_schema: workerDecisionSchema(observation),
          },
          null,
          2
        ),
      },
    ],
  };
}

function prepareWorkerObservationForLlm(observation) {
  const llmObservation = JSON.parse(JSON.stringify(observation));
  const candidateIds = (llmObservation.candidateDemands || []).map((demand) => demand.demandId);
  llmObservation.legalCandidateDemandIds = candidateIds;
  llmObservation.decisionProtocol = {
    assignableDemandSource: "candidateDemands only",
    forbiddenTargetSources: ["broadcastBoard", "workerMemory", "completedDemandIds", "waitingDemandIds"],
    noCandidateAction: "reject_all",
  };
  llmObservation.broadcastBoard = {
    note: "Informational only. Demand IDs from the broadcast board are not legal targets unless they also appear in candidateDemands.",
  };
  return llmObservation;
}

function parseDecisionContent(content, observation) {
  return normalizeDecision(JSON.parse(extractJsonObject(stripJsonFence(content))), observation);
}

function loadWorkerSystemPrompt(agentId) {
  const alias = loadScenarioPromptAlias("Worker-Agent");
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
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    timeoutSeconds: cfg.timeoutSeconds,
    jsonMode: cfg.jsonMode,
  };
}

module.exports = {
  decideWorkerWithLlm,
  loadLlmConfig,
};
