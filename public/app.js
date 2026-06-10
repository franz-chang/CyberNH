const app = {
  snapshot: null,
  ws: null,
  selectedAgentId: "Assistant-01",
  configTimer: null,
  gridRendered: false,
  syncingControls: false,
  language: localStorage.getItem("cybernh.language") || "zh",
};

const controlBindings = [
  ["simSpeedRange", "simSpeed", "number"],
  ["randomSeedInput", "randomSeed", "number"],
  ["durationSelect", "durationTicks", "number"],
  ["peakWindowSelect", "peakWindow", "string"],
  ["simulationDaysInput", "simulationDays", "number"],
  ["shiftSelect", "shift", "string"],
  ["congestionSelect", "congestion", "string"],
  ["workerCountInput", "workerCount", "number"],
  ["wingDistributionSelect", "wingDistribution", "string"],
  ["oneToOneDayInput", "oneToOneDay", "number"],
  ["oneToOneFullDayInput", "oneToOneFullDay", "number"],
  ["nightWorkerCountInput", "nightWorkerCount", "number"],
  ["seniorCountInput", "seniorCount", "number"],
  ["careLevel1RatioInput", "careLevel1Ratio", "number"],
  ["careLevel2RatioInput", "careLevel2Ratio", "number"],
  ["careLevel3RatioInput", "careLevel3Ratio", "number"],
  ["autoNormalizeCareLevelToggle", "autoNormalizeCareLevel", "boolean"],
  ["demandIntensitySelect", "demandIntensity", "string"],
  ["manualGenerateCountInput", "manualGenerateCount", "number"],
  ["escalationThresholdInput", "escalationThresholdTicks", "number"],
  ["maxPendingDemandInput", "maxPendingDemand", "number"],
  ["maxActiveTaskInput", "maxActiveTask", "number"],
  ["twoPersonTaskToggle", "twoPersonTaskEnabled", "boolean"],
  ["interruptionToggle", "interruptionEnabled", "boolean"],
  ["careModeSelect", "careMode", "string"],
  ["agentDecisionModeSelect", "agentDecisionMode", "string"],
  ["assistantAgentToggle", "assistantAgentEnabled", "boolean"],
  ["seniorAgentLlmToggle", "seniorAgentLlmEnabled", "boolean"],
  ["workerAgentLlmToggle", "workerAgentLlmEnabled", "boolean"],
];

const i18n = {
  zh: {
    "actions.run": "运行",
    "actions.pause": "暂停",
    "actions.stop": "停止",
    "actions.reset": "重置",
    "actions.done": "完成",
    "actions.export": "导出实验数据",
    "actions.generateDemand": "生成需求",
    "actions.read": "读取",
    "connection.live": "在线",
    "connection.offline": "离线",
    "connection.connecting": "连接中",
    "map.kicker": "实时楼层平面",
    "map.title": "地图视图",
    "map.subtitle": "原 CyberNH_GUI 地图 · 40 房间 · 35×25",
    "map.pending": "等待需求",
    "map.active": "活跃任务",
    "map.idleWorkers": "空闲护理员",
    "map.load": "负载",
    "panel.simulationControl": "仿真控制",
    "panel.scenarioStaffingConfig": "场景与人力配置",
    "panel.scenarioConfig": "场景配置",
    "panel.staffingConfig": "人力配置",
    "panel.residentConfig": "老人配置",
    "panel.demandGeneration": "需求生成",
    "panel.runtimeStatus": "运行状态",
    "panel.broadcastBoard": "双行广播板",
    "panel.memoryInspector": "Agent 记忆查看",
    "panel.metricsDashboard": "指标看板",
    "panel.eventLog": "事件日志",
    "board.seniorDemandRow": "老人需求行",
    "board.workerResourceRow": "护理员资源行",
    "field.simSpeed": "仿真速度",
    "field.randomSeed": "随机种子",
    "field.duration": "观察窗口",
    "field.peakWindow": "高峰窗口",
    "field.simDays": "模拟天数",
    "field.shift": "班次",
    "field.congestion": "拥堵水平",
    "field.workerCount": "Worker 数量",
    "field.wingDistribution": "楼翼分布",
    "field.oneToOneDay": "一对一日班",
    "field.oneToOneFullDay": "全日一对一",
    "field.nightWorkerCount": "夜班 Worker",
    "field.seniorCount": "Senior 数量",
    "field.careLevel1": "护理等级 1",
    "field.careLevel2": "护理等级 2",
    "field.careLevel3": "护理等级 3",
    "field.autoNormalize": "自动归一化",
    "field.demandIntensity": "需求强度",
    "field.manualCount": "手动数量",
    "field.escalationThreshold": "升级阈值",
    "field.maxPendingDemand": "最大等待需求",
    "field.maxActiveTask": "最大活跃任务",
    "field.twoPersonTask": "双人任务",
    "field.interruption": "任务中断",
    "field.careMode": "照护模式",
    "field.agentDecision": "Agent 决策",
    "field.assistantAgent": "Assistant-Agent",
    "field.seniorAgentLlm": "Senior-Agent LLM",
    "field.workerAgentLlm": "Worker-Agent LLM",
    "option.peak.full_day": "全天 00:00-24:00",
    "option.peak.morning_peak": "早高峰 06:30-08:30",
    "option.peak.midday_peak": "午间高峰 10:30-12:30",
    "option.peak.evening_peak": "晚高峰 17:00-19:00",
    "option.peak.evening_intensive": "晚间强化 17:00-18:30",
    "option.shift.day_shift": "日班",
    "option.shift.evening_shift": "晚班",
    "option.shift.night_shift": "夜班",
    "option.level.low": "低",
    "option.level.medium": "中",
    "option.level.high": "高",
    "option.level.overcooked": "压力测试",
    "option.wing.balanced": "均衡",
    "option.wing.wing_a_heavy": "A 翼偏重",
    "option.wing.wing_b_heavy": "B 翼偏重",
    "option.care.moral_care": "道德照护",
    "option.care.practical_care": "实用照护",
    "option.care.relational_care": "关系照护",
    "option.decision.rule_only": "仅规则驱动",
    "option.decision.llm_required": "LLM 驱动",
    "legend.corridor": "走廊",
    "legend.room": "房间",
    "legend.nurse": "护士站",
    "legend.activity": "活动区",
    "legend.dining": "餐区",
    "legend.balcony": "阳台",
    "legend.storage": "储物",
    "legend.courtyard": "庭院",
    "legend.worker": "护理员",
    "legend.senior": "老人",
    "status.tick": "Tick",
    "status.simulationDay": "模拟天数",
    "status.simulationTime": "仿真时间",
    "status.peakWindow": "高峰窗口",
    "status.careMode": "照护模式",
    "status.systemLoad": "系统负载",
    "status.pendingDemands": "等待需求",
    "status.activeTasks": "活跃任务",
    "status.idleWorkers": "空闲护理员",
    "status.movingWorkers": "移动中护理员",
    "status.servingWorkers": "服务中护理员",
    "status.unavailableWorkers": "不可用护理员",
    "status.equipment": "设备",
    "metrics.generated": "已生成",
    "metrics.completed": "已完成",
    "metrics.completionRate": "完成率",
    "metrics.averageWait": "平均等待",
    "metrics.p95Wait": "P95 等待",
    "metrics.timeoutRate": "超时率",
    "metrics.escalations": "升级次数",
    "metrics.walkingDistance": "行走距离",
    "metrics.processingTicks": "处理 Tick",
    "metrics.heavyTaskGini": "重任务 Gini",
    "metrics.coordinationWait": "协作等待",
    "metrics.interruptedTasks": "中断任务",
    "header.status": "第 {day} 天 · Tick {tick} / {total} · {time} · {load}",
    "board.wait": "等待",
    "board.esc": "升级",
    "board.need": "需要",
    "board.remain": "剩余",
    "board.fatigue": "疲劳",
    "board.loc": "位置",
    "board.workerUnit": "人",
    "board.minute": "分",
    "assistant.normal": "Assistant：负载正常",
    "assistant.high": "Assistant：高负载 / 优先处理紧急等待需求",
    "assistant.risk": "Assistant：风险负载 / 优先升级与高照护需求",
    "assistant.overloaded": "Assistant：过载 / 减少移动并完成活跃任务",
    "assistant.equipmentShortage": "Assistant：设备短缺 {ids}",
    "assistant.coordinationWarning": "Assistant：协作预警 {ids}",
    "event.simulationReset": "仿真已重置",
    "event.configUpdated": "配置已更新",
    "event.simulationStarted": "仿真已启动",
    "event.simulationPaused": "仿真已暂停",
    "event.simulationStopped": "仿真已停止",
    "event.serviceStarted": "{id} 服务已开始",
  },
  en: {
    "actions.run": "Run",
    "actions.pause": "Pause",
    "actions.stop": "Stop",
    "actions.reset": "Reset",
    "actions.done": "Done",
    "actions.export": "Export data",
    "actions.generateDemand": "Generate",
    "actions.read": "Read",
    "connection.live": "Live",
    "connection.offline": "Offline",
    "connection.connecting": "Connecting",
    "map.kicker": "Live Floor Plate",
    "map.title": "Map View",
    "map.subtitle": "Original CyberNH_GUI Map · 40 Rooms · 35×25",
    "map.pending": "Pending",
    "map.active": "Active",
    "map.idleWorkers": "Idle Workers",
    "map.load": "Load",
    "panel.simulationControl": "Simulation Control",
    "panel.scenarioStaffingConfig": "Scenario & Staffing Configuration",
    "panel.scenarioConfig": "Scenario Configuration",
    "panel.staffingConfig": "Staffing Configuration",
    "panel.residentConfig": "Resident Configuration",
    "panel.demandGeneration": "Demand Generation",
    "panel.runtimeStatus": "Runtime Status",
    "panel.broadcastBoard": "Two-Line Broadcast Board",
    "panel.memoryInspector": "Agent Memory Inspector",
    "panel.metricsDashboard": "Metrics Dashboard",
    "panel.eventLog": "Event Log",
    "board.seniorDemandRow": "Senior Demand Row",
    "board.workerResourceRow": "Worker Resource Row",
    "field.simSpeed": "Simulation speed",
    "field.randomSeed": "Random seed",
    "field.duration": "Observation window",
    "field.peakWindow": "Peak window",
    "field.simDays": "Simulation days",
    "field.shift": "Shift",
    "field.congestion": "Congestion",
    "field.workerCount": "Worker count",
    "field.wingDistribution": "Wing distribution",
    "field.oneToOneDay": "1:1 day shift",
    "field.oneToOneFullDay": "1:1 full day",
    "field.nightWorkerCount": "Night workers",
    "field.seniorCount": "Senior count",
    "field.careLevel1": "Care Level 1",
    "field.careLevel2": "Care Level 2",
    "field.careLevel3": "Care Level 3",
    "field.autoNormalize": "Auto normalize",
    "field.demandIntensity": "Demand intensity",
    "field.manualCount": "Manual count",
    "field.escalationThreshold": "Escalation threshold",
    "field.maxPendingDemand": "Max pending",
    "field.maxActiveTask": "Max active tasks",
    "field.twoPersonTask": "Two-person tasks",
    "field.interruption": "Interruptions",
    "field.careMode": "Care mode",
    "field.agentDecision": "Agent decision",
    "field.assistantAgent": "Assistant-Agent",
    "field.seniorAgentLlm": "Senior-Agent LLM",
    "field.workerAgentLlm": "Worker-Agent LLM",
    "option.peak.full_day": "Full day",
    "option.peak.morning_peak": "Morning 06:30-08:30",
    "option.peak.midday_peak": "Midday 10:30-12:30",
    "option.peak.evening_peak": "Evening 17:00-19:00",
    "option.peak.evening_intensive": "Intensive 17:00-18:30",
    "option.shift.day_shift": "Day Shift",
    "option.shift.evening_shift": "Evening Shift",
    "option.shift.night_shift": "Night Shift",
    "option.level.low": "Low",
    "option.level.medium": "Medium",
    "option.level.high": "High",
    "option.level.overcooked": "Stress test",
    "option.wing.balanced": "Balanced",
    "option.wing.wing_a_heavy": "Wing A Heavy",
    "option.wing.wing_b_heavy": "Wing B Heavy",
    "option.care.moral_care": "Moral Care",
    "option.care.practical_care": "Practical Care",
    "option.care.relational_care": "Relational Care",
    "option.decision.rule_only": "Rule Only Driven",
    "option.decision.llm_required": "LLM Driven",
    "legend.corridor": "Corridor",
    "legend.room": "Room",
    "legend.nurse": "Nurse",
    "legend.activity": "Activity",
    "legend.dining": "Dining",
    "legend.balcony": "Balcony",
    "legend.storage": "Storage",
    "legend.courtyard": "Courtyard",
    "legend.worker": "Worker",
    "legend.senior": "Senior",
    "status.tick": "Tick",
    "status.simulationDay": "Simulation Day",
    "status.simulationTime": "Simulation Time",
    "status.peakWindow": "Peak Window",
    "status.careMode": "Care Mode",
    "status.systemLoad": "System Load",
    "status.pendingDemands": "Pending Demands",
    "status.activeTasks": "Active Tasks",
    "status.idleWorkers": "Idle Workers",
    "status.movingWorkers": "Moving Workers",
    "status.servingWorkers": "Serving Workers",
    "status.unavailableWorkers": "Unavailable Workers",
    "status.equipment": "Equipment",
    "metrics.generated": "Generated",
    "metrics.completed": "Completed",
    "metrics.completionRate": "Completion Rate",
    "metrics.averageWait": "Average Wait",
    "metrics.p95Wait": "P95 Wait",
    "metrics.timeoutRate": "Timeout Rate",
    "metrics.escalations": "Escalations",
    "metrics.walkingDistance": "Walking Distance",
    "metrics.processingTicks": "Processing Ticks",
    "metrics.heavyTaskGini": "Heavy Task Gini",
    "metrics.coordinationWait": "Coordination Wait",
    "metrics.interruptedTasks": "Interrupted Tasks",
    "header.status": "Day {day} · Tick {tick} / {total} · {time} · {load}",
    "board.wait": "wait",
    "board.esc": "esc",
    "board.need": "need",
    "board.remain": "remain",
    "board.fatigue": "fatigue",
    "board.loc": "loc",
    "board.workerUnit": "W",
    "board.minute": "m",
    "assistant.normal": "Assistant: Normal load",
    "assistant.high": "Assistant: High Load / prioritize urgent waiting demands",
    "assistant.risk": "Assistant: Risk load / prioritize escalated and high-care demands",
    "assistant.overloaded": "Assistant: Overloaded / reduce travel and finish active tasks",
    "assistant.equipmentShortage": "Assistant: Equipment shortage for {ids}",
    "assistant.coordinationWarning": "Assistant: Coordination warning {ids}",
    "event.simulationReset": "Simulation reset",
    "event.configUpdated": "Configuration updated",
    "event.simulationStarted": "Simulation started",
    "event.simulationPaused": "Simulation paused",
    "event.simulationStopped": "Simulation stopped",
    "event.serviceStarted": "{id} service started",
  },
};

const enumTranslations = {
  load: {
    low: { zh: "低", en: "Low" },
    normal: { zh: "正常", en: "Normal" },
    high: { zh: "高", en: "High" },
    risk: { zh: "风险", en: "Risk" },
    overloaded: { zh: "过载", en: "Overloaded" },
  },
  status: {
    idle: { zh: "空闲", en: "idle" },
    moving: { zh: "移动中", en: "moving" },
    serving: { zh: "服务中", en: "serving" },
    unavailable: { zh: "不可用", en: "unavailable" },
    waiting: { zh: "等待中", en: "waiting" },
    assigned: { zh: "已分配", en: "assigned" },
    in_service: { zh: "服务中", en: "in service" },
    completed: { zh: "已完成", en: "completed" },
    coordination_waiting: { zh: "协作等待", en: "coordination waiting" },
    timeout_escalated: { zh: "超时升级", en: "timeout escalated" },
    waiting_for_equipment: { zh: "等待设备", en: "waiting for equipment" },
  },
};

const taskLabelTranslations = {
  巡视: "patrol",
  饮水: "water",
  取物: "fetch item",
  用药提醒: "medication reminder",
  喂饭: "feeding",
  如厕协助: "toileting assistance",
  翻身: "turning",
  清洁护理: "cleaning care",
  换尿布: "diaper change",
  床椅转移: "bed-chair transfer",
  紧急呼叫: "emergency call",
};

const equipmentTranslations = {
  wheelchair: { zh: "轮椅", en: "wheelchair" },
  commode_trolley: { zh: "坐便推车", en: "commode trolley" },
  medicine_cart: { zh: "药车", en: "medicine cart" },
  cleaning_kit: { zh: "清洁包", en: "cleaning kit" },
  轮椅: { zh: "轮椅", en: "wheelchair" },
  坐便推车: { zh: "坐便推车", en: "commode trolley" },
  药车: { zh: "药车", en: "medicine cart" },
  清洁包: { zh: "清洁包", en: "cleaning kit" },
};

document.addEventListener("DOMContentLoaded", () => {
  bindLanguageSwitch();
  applyLanguage();
  bindControls();
  renderLegend();
  connectWebSocket();
  fetchSnapshot();
});

function $(id) {
  return document.getElementById(id);
}

function bindLanguageSwitch() {
  document.querySelectorAll(".lang-option").forEach((button) => {
    button.addEventListener("click", () => setLanguage(button.dataset.lang));
  });
}

function setLanguage(language) {
  if (!i18n[language] || app.language === language) return;
  app.language = language;
  localStorage.setItem("cybernh.language", language);
  applyLanguage();
}

function applyLanguage() {
  if (!i18n[app.language]) app.language = "zh";
  document.documentElement.lang = app.language === "zh" ? "zh-CN" : "en";

  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n, element.textContent);
  });

  document.querySelectorAll(".lang-option").forEach((button) => {
    const active = button.dataset.lang === app.language;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  if ($("connectionBadge")) {
    setConnection(app.ws ? app.ws.readyState === WebSocket.OPEN : null);
  }

  renderLegend();
  if (!app.snapshot) return;
  renderMarkers(app.snapshot);
  renderMapTelemetry(app.snapshot);
  renderRuntimeStatus(app.snapshot);
  renderBroadcastBoard(app.snapshot.broadcastBoard);
  renderMetrics(app.snapshot.metrics);
  renderEventLog(app.snapshot.eventLog || []);
  updateHeader(app.snapshot);
}

function t(key, fallbackOrParams = {}, maybeParams = {}) {
  let fallback = key;
  let params = {};
  if (typeof fallbackOrParams === "string") {
    fallback = fallbackOrParams;
    params = maybeParams || {};
  } else {
    params = fallbackOrParams || {};
  }
  const text = i18n[app.language]?.[key] ?? i18n.zh?.[key] ?? i18n.en?.[key] ?? fallback;
  return formatTemplate(text, params);
}

function formatTemplate(text, params = {}) {
  return String(text).replace(/\{(\w+)\}/g, (_, key) => params[key] ?? "");
}

function optionLabel(group, value) {
  return t(`option.${group}.${value}`, titleCase(value));
}

function enumLabel(group, value) {
  return enumTranslations[group]?.[value]?.[app.language] ?? titleCase(value);
}

function taskLabel(label) {
  if (app.language === "zh") return label;
  return taskLabelTranslations[label] || label;
}

function equipmentLabel(name) {
  const entry = equipmentTranslations[name];
  return entry?.[app.language] ?? name;
}

function assistantMessage(message) {
  const text = String(message || "");
  const equipmentShortage = text.match(/^Assistant: equipment shortage for (.+)$/);
  if (equipmentShortage) return t("assistant.equipmentShortage", { ids: equipmentShortage[1] });
  const coordinationWarning = text.match(/^Assistant: coordination warning (.+)$/);
  if (coordinationWarning) return t("assistant.coordinationWarning", { ids: coordinationWarning[1] });
  if (text.includes("Overloaded")) return t("assistant.overloaded");
  if (text.includes("Risk load")) return t("assistant.risk");
  if (text.includes("High Load")) return t("assistant.high");
  if (text.includes("Normal load")) return t("assistant.normal");
  return app.language === "zh" ? text.replace("Assistant:", "Assistant：") : text.replace("Assistant：", "Assistant:");
}

function eventMessage(message) {
  const text = String(message || "");
  const exact = {
    "Simulation reset": "event.simulationReset",
    "Configuration updated": "event.configUpdated",
    "Simulation started": "event.simulationStarted",
    "Simulation paused": "event.simulationPaused",
    "Simulation stopped": "event.simulationStopped",
  };
  if (exact[text]) return t(exact[text]);

  const serviceStarted = text.match(/^(\S+) service started$/);
  if (serviceStarted) return t("event.serviceStarted", { id: serviceStarted[1] });

  if (app.language === "en") {
    return Object.entries(taskLabelTranslations).reduce(
      (translated, [zhLabel, enLabel]) => translated.replaceAll(zhLabel, enLabel),
      text
    );
  }
  return text;
}

function bindControls() {
  $("runBtn").addEventListener("click", runSimulation);
  $("headerRunBtn").addEventListener("click", runSimulation);
  $("pauseBtn").addEventListener("click", () => postJson("/api/pause"));
  $("stopBtn").addEventListener("click", () => postJson("/api/stop"));
  $("resetBtn").addEventListener("click", () => postJson("/api/reset", { config: exportSnapshot() }));
  $("manualGenerateBtn").addEventListener("click", () => {
    postJson("/api/manual-demand", { count: numberValue("manualGenerateCountInput", 3) });
  });
  $("exportBtn").addEventListener("click", exportExperimentData);
  $("memoryRefreshBtn").addEventListener("click", () => selectMemory($("memoryAgentSelect").value));
  $("memoryAgentSelect").addEventListener("change", (event) => selectMemory(event.target.value));
  $("peakWindowSelect").addEventListener("change", () => {
    if ($("peakWindowSelect").value === "full_day") {
      $("durationSelect").value = "1440";
    }
  });

  for (const [id] of controlBindings) {
    const element = $(id);
    if (!element || element.disabled) continue;
    element.addEventListener("change", scheduleConfigSync);
    if (element.type === "range") element.addEventListener("input", scheduleConfigSync);
  }
}

function runSimulation() {
  postJson("/api/run", { config: exportSnapshot() });
}

function scheduleConfigSync() {
  if (app.syncingControls) return;
  clearTimeout(app.configTimer);
  app.configTimer = setTimeout(() => {
    postJson("/api/config", exportSnapshot());
  }, 180);
}

function normalizeAgentDecisionMode(value) {
  return value === "camel_worker" ? "llm_required" : value;
}

function exportSnapshot() {
  const config = {};
  for (const [id, key, type] of controlBindings) {
    const element = $(id);
    if (!element) continue;
    if (type === "boolean") config[key] = Boolean(element.checked);
    if (type === "number") config[key] = numberValue(id, 0);
    if (type === "string") config[key] = key === "agentDecisionMode" ? normalizeAgentDecisionMode(element.value) : element.value;
  }
  return config;
}

window.exportSnapshot = exportSnapshot;

function applyConfigToControls(config) {
  app.syncingControls = true;
  for (const [id, key, type] of controlBindings) {
    const element = $(id);
    if (!element || config[key] === undefined) continue;
    if (type === "boolean") element.checked = Boolean(config[key]);
    else element.value = String(key === "agentDecisionMode" ? normalizeAgentDecisionMode(config[key]) : config[key]);
  }
  app.syncingControls = false;
}

function numberValue(id, fallback) {
  const value = Number($(id)?.value);
  return Number.isFinite(value) ? value : fallback;
}

async function fetchSnapshot() {
  const snapshot = await getJson("/api/snapshot");
  handleSnapshot(snapshot);
}

function connectWebSocket() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  app.ws = new WebSocket(`${protocol}//${location.host}/ws/sim`);
  app.ws.addEventListener("open", () => setConnection(true));
  app.ws.addEventListener("close", () => {
    setConnection(false);
    setTimeout(connectWebSocket, 1200);
  });
  app.ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "snapshot.full" || message.type === "snapshot.patch") {
      handleSnapshot(message.payload);
    }
    if (message.type === "log.event") {
      if (app.snapshot) {
        app.snapshot.eventLog ||= [];
        app.snapshot.eventLog.unshift(message.payload);
        renderEventLog(app.snapshot.eventLog);
      }
    }
    if (message.type === "agent.memory.updated" && message.payload.agentId === app.selectedAgentId) {
      renderMemory(message.payload.memory);
    }
  });
}

function setConnection(connected) {
  const badge = $("connectionBadge");
  badge.textContent = connected === null ? t("connection.connecting") : connected ? t("connection.live") : t("connection.offline");
  badge.classList.toggle("live", connected === true);
  badge.classList.toggle("muted", connected !== true);
}

async function getJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function postJson(path, payload = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(await response.text());
  const result = await response.json();
  if (result.snapshot) handleSnapshot(result.snapshot);
  else if (result.version) handleSnapshot(result);
  else if (result.config) handleSnapshot(result);
  return result;
}

function handleSnapshot(snapshot) {
  app.snapshot = snapshot;
  applyConfigToControls(snapshot.config || {});
  if (!app.gridRendered) renderGrid(snapshot.map);
  renderMarkers(snapshot);
  renderMapTelemetry(snapshot);
  renderRuntimeStatus(snapshot);
  renderBroadcastBoard(snapshot.broadcastBoard);
  renderMetrics(snapshot.metrics);
  renderEventLog(snapshot.eventLog || []);
  updateMemorySelect(snapshot);
  updateHeader(snapshot);
  if (app.selectedAgentId) refreshSelectedMemoryFromSnapshot();
}

function updateHeader(snapshot) {
  const load = snapshot.metrics?.systemLoad || "normal";
  const totalTicks = snapshot.config.totalDurationTicks || snapshot.config.durationTicks;
  document.body.dataset.load = String(load);
  $("headerStatus").textContent = t("header.status", {
    day: snapshot.simulationDay || 1,
    tick: snapshot.tick,
    total: totalTicks,
    time: snapshot.currentTime,
    load: enumLabel("load", load),
  });
  $("headerRunBtn").textContent = snapshot.tick >= totalTicks ? t("actions.done") : t("actions.run");
}

function renderLegend() {
  const items = [
    "corridor",
    "room",
    "nurse",
    "activity",
    "dining",
    "balcony",
    "storage",
    "courtyard",
    "worker",
    "senior",
  ];
  $("mapLegend").innerHTML = items
    .map((key) => `<span class="legend-item"><span class="legend-swatch ${key}"></span>${escapeHtml(t(`legend.${key}`))}</span>`)
    .join("");
}

function renderGrid(map) {
  const gridLayer = $("gridLayer");
  gridLayer.innerHTML = "";
  const roomByTile = new Map(map.roomTargets.map((room) => [`${room.tile.x},${room.tile.y}`, room.room]));
  const areaByTile = new Map(map.areaLabels.map((area) => [`${area.tile.x},${area.tile.y}`, area.label]));

  for (let y = 0; y < map.rows; y += 1) {
    for (let x = 0; x < map.cols; x += 1) {
      const tile = document.createElement("div");
      const terrain = map.grid[y][x];
      tile.className = `tile ${terrain}`;
      tile.style.gridColumn = String(x + 1);
      tile.style.gridRow = String(y + 1);
      const label = roomByTile.get(`${x},${y}`) || areaByTile.get(`${x},${y}`);
      if (label) {
        const text = document.createElement("span");
        text.className = "tile-label";
        text.textContent = label;
        tile.append(text);
      }
      gridLayer.append(tile);
    }
  }
  app.gridRendered = true;
}

function renderMarkers(snapshot) {
  const layer = $("markerLayer");
  layer.innerHTML = "";
  const seniors = Object.values(snapshot.seniors);
  const workers = Object.values(snapshot.workers);
  const demands = snapshot.queue1?.demands || [];

  for (const worker of workers) {
    if (worker.status !== "moving" || !Array.isArray(worker.route)) continue;
    const upcoming = worker.route.slice(worker.routeIndex + 1, worker.routeIndex + 9);
    for (const [index, tile] of upcoming.entries()) {
      const dot = document.createElement("span");
      dot.className = "route-dot";
      dot.style.gridColumn = String(tile.x + 1);
      dot.style.gridRow = String(tile.y + 1);
      dot.style.opacity = String(Math.max(0.25, 0.8 - index * 0.07));
      layer.append(dot);
    }
  }

  for (const demand of demands) {
    if (demand.status === "completed") continue;
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = `demand-marker status-${demand.status} class-${demand.taskClass}`;
    marker.style.gridColumn = String(demand.tile.x + 1);
    marker.style.gridRow = String(demand.tile.y + 1);
    marker.title = `${demand.demandId} ${demand.room} ${taskLabel(demand.taskLabelZh)} P${demand.priorityLevel}`;
    marker.textContent = `P${demand.priorityLevel}`;
    marker.addEventListener("click", () => selectMemory(demand.seniorId));
    layer.append(marker);
  }

  for (const senior of seniors) {
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = `marker senior ${senior.currentStatus} care-level-${senior.careLevel}`;
    marker.style.gridColumn = String(senior.tile.x + 1);
    marker.style.gridRow = String(senior.tile.y + 1);
    marker.title = `${senior.id} ${senior.room} ${app.language === "zh" ? "护理等级" : "Care Level"} ${senior.careLevel}`;
    marker.textContent = senior.currentStatus === "idle" ? "" : `L${senior.careLevel}`;
    marker.addEventListener("click", () => selectMemory(senior.id));
    layer.append(marker);
  }

  for (const worker of workers) {
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = `marker worker ${worker.status}`;
    marker.style.gridColumn = String(worker.tile.x + 1);
    marker.style.gridRow = String(worker.tile.y + 1);
    marker.title = `${worker.id} ${enumLabel("status", worker.status)} F=${worker.fatigue.toFixed(2)}`;
    marker.setAttribute("aria-label", marker.title);
    marker.append(buildWorkerMarkerVisual(worker));
    marker.addEventListener("click", () => selectMemory(worker.id));
    layer.append(marker);
  }
}

function renderMapTelemetry(snapshot) {
  const metrics = snapshot.metrics || {};
  const workers = Object.values(snapshot.workers || {});
  $("mapPendingCount").textContent = String(metrics.pendingDemandCount || 0);
  $("mapActiveCount").textContent = String(metrics.activeDemandCount || 0);
  $("mapIdleWorkerCount").textContent = String(workers.filter((worker) => worker.status === "idle").length);
  $("mapLoadState").textContent = enumLabel("load", metrics.systemLoad || "low");
}

function workerShortLabel(workerId) {
  if (workerId.startsWith("Worker-N")) return workerId.replace("Worker-", "");
  return workerId.replace("Worker-", "W").replace(/^W0/, "W");
}

function buildWorkerMarkerVisual(worker) {
  const shell = document.createElement("span");
  shell.className = "worker-marker-shell";
  shell.setAttribute("aria-hidden", "true");

  const shadow = document.createElement("span");
  shadow.className = "worker-shadow";

  const sprite = document.createElement("span");
  sprite.className = "worker-sprite";

  for (const partName of ["hat", "head", "body", "apron", "legs"]) {
    const part = document.createElement("span");
    part.className = `worker-${partName}`;
    sprite.append(part);
  }

  const badge = document.createElement("span");
  badge.className = "worker-badge";
  badge.textContent = workerShortLabel(worker.id);

  shell.append(shadow, sprite, badge);
  return shell;
}

function renderRuntimeStatus(snapshot) {
  const metrics = snapshot.metrics || {};
  const equipment = snapshot.equipment || {};
  const workers = Object.values(snapshot.workers || {});
  const pending = metrics.pendingDemandCount || 0;
  const active = metrics.activeDemandCount || 0;
  const equipmentBars = renderEquipmentBars(equipment);
  const rows = [
    [t("status.tick"), `${snapshot.tick} / ${snapshot.config.totalDurationTicks || snapshot.config.durationTicks}`],
    [t("status.simulationDay"), `${snapshot.simulationDay || 1} / ${snapshot.config.simulationDays || 1}`],
    [t("status.simulationTime"), snapshot.currentTime],
    [t("status.peakWindow"), optionLabel("peak", snapshot.config.peakWindow)],
    [t("status.careMode"), optionLabel("care", snapshot.config.careMode)],
    [t("status.systemLoad"), enumLabel("load", metrics.systemLoad || "normal")],
    [t("status.pendingDemands"), pending],
    [t("status.activeTasks"), active],
    [t("status.idleWorkers"), workers.filter((worker) => worker.status === "idle").length],
    [t("status.movingWorkers"), workers.filter((worker) => worker.status === "moving").length],
    [t("status.servingWorkers"), workers.filter((worker) => worker.status === "serving").length],
    [t("status.unavailableWorkers"), workers.filter((worker) => worker.status === "unavailable").length],
    [t("status.equipment"), { html: equipmentBars, className: "equipment-status-cell" }],
  ];
  $("runtimeStatusList").innerHTML = rows
    .map(([key, value]) => {
      if (typeof value === "object" && value?.html !== undefined) {
        const className = value.className ? ` class="${escapeHtml(value.className)}"` : "";
        return `<dt>${escapeHtml(key)}</dt><dd${className}>${value.html}</dd>`;
      }
      return `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`;
    })
    .join("");
}

function renderEquipmentBars(equipment) {
  const entries = Object.values(equipment || {});
  if (!entries.length) return `<span class="equipment-empty">-</span>`;
  return `<div class="equipment-bars">${entries
    .map((item) => {
      const total = Math.max(0, Number(item.total) || 0);
      const available = Math.min(total, Math.max(0, Number(item.available) || 0));
      const label = equipmentLabel(item.labelZh);
      const segments = Math.max(1, total);
      const cells = Array.from({ length: segments }, (_, index) => {
        const state = index < available ? "available" : "occupied";
        return `<span class="equipment-segment ${state}"></span>`;
      }).join("");
      const stateClass = available === 0 ? "empty" : available === total ? "full" : "partial";
      const statusText = `${label} ${available} / ${total}`;
      return `<span class="equipment-bar ${stateClass}" title="${escapeHtml(statusText)}" aria-label="${escapeHtml(statusText)}"><span class="equipment-name">${escapeHtml(label)}</span><span class="equipment-segments" style="--segments: ${segments}" aria-hidden="true">${cells}</span></span>`;
    })
    .join("")}</div>`;
}

function renderBroadcastBoard(board) {
  const minute = t("board.minute");
  const workerUnit = t("board.workerUnit");
  $("seniorDemandRow").innerHTML = (board?.seniorDemandRow || [])
    .map((item) => {
      const requiredEquipment = item.requiredEquipment || [];
      const equipment = requiredEquipment.length
        ? ` · ${requiredEquipment.map((name) => escapeHtml(equipmentLabel(name))).join("/")}`
        : "";
      return `<li class="status-${classToken(item.status)}"><span class="board-code">${escapeHtml(item.demandId)} · ${escapeHtml(item.room)} · P${item.priorityLevel}</span><span class="board-detail">${escapeHtml(taskLabel(item.taskLabelZh))} · ${escapeHtml(t("board.wait"))} ${pad2(item.waitingTicks)}${escapeHtml(minute)} · ${escapeHtml(t("board.esc"))} ${item.escalationCount} · ${escapeHtml(t("board.need"))} ${item.requiredWorkers}${escapeHtml(workerUnit)}${equipment} · <span class="board-status">${escapeHtml(enumLabel("status", item.status))}</span></span></li>`;
    })
    .join("");

  $("workerResourceRow").innerHTML = (board?.workerResourceRow || [])
    .map((item) => {
      const task = item.currentTaskId
        ? ` · ${escapeHtml(item.currentTaskId)} · ${escapeHtml(t("board.remain"))} ${item.remainingServiceTicks ?? "-"}${escapeHtml(minute)}`
        : "";
      return `<li class="status-${classToken(item.status)}"><span class="board-code">${escapeHtml(item.workerId)} · ${escapeHtml(item.wing)}</span><span class="board-detail">${escapeHtml(enumLabel("status", item.status))}${task} · ${escapeHtml(t("board.fatigue"))} ${item.fatigue.toFixed(2)} · ${escapeHtml(t("board.loc"))} ${escapeHtml(item.locationLabel)}</span></li>`;
    })
    .join("");
  $("assistantBroadcast").textContent = assistantMessage(board?.assistantMessage);
}

function renderMetrics(metrics = {}) {
  const rows = [
    [t("metrics.generated"), metrics.generatedDemandCount],
    [t("metrics.completed"), metrics.completedDemandCount],
    [t("metrics.completionRate"), percent(metrics.taskCompletionRate)],
    [t("metrics.averageWait"), `${metrics.averageWaitingTicks ?? 0}${t("board.minute")}`],
    [t("metrics.p95Wait"), `${metrics.p95WaitingTicks ?? 0}${t("board.minute")}`],
    [t("metrics.timeoutRate"), percent(metrics.timeoutRate)],
    [t("metrics.escalations"), metrics.escalationCount],
    [t("metrics.walkingDistance"), `${metrics.totalWalkingDistanceM ?? 0}m`],
    [t("metrics.processingTicks"), metrics.totalTaskProcessingTicks],
    [t("metrics.heavyTaskGini"), metrics.heavyTaskGini],
    [t("metrics.coordinationWait"), `${metrics.coordinationWaitingTicksTotal ?? 0}${t("board.minute")}`],
    [t("metrics.interruptedTasks"), metrics.interruptedTaskCount],
  ];
  $("metricsList").innerHTML = rows.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join("");
}

function renderEventLog(events) {
  $("eventLog").innerHTML = events
    .slice(0, 60)
    .map(
      (event) =>
        `<li><span class="event-time">T${event.tick} ${escapeHtml(event.time || "")}</span><span class="event-message ${escapeHtml(event.severity)}">${escapeHtml(eventMessage(event.message))}</span></li>`
    )
    .join("");
}

function updateMemorySelect(snapshot) {
  const select = $("memoryAgentSelect");
  const ids = ["Assistant-01", ...Object.keys(snapshot.workers || {}), ...Object.keys(snapshot.seniors || {})];
  const currentOptions = Array.from(select.options).map((option) => option.value).join("|");
  if (currentOptions === ids.join("|")) return;
  select.innerHTML = ids.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join("");
  select.value = app.selectedAgentId && ids.includes(app.selectedAgentId) ? app.selectedAgentId : "Assistant-01";
  app.selectedAgentId = select.value;
}

function refreshSelectedMemoryFromSnapshot() {
  const snapshot = app.snapshot;
  let memory = snapshot.assistant?.memory;
  if (snapshot.workers?.[app.selectedAgentId]) memory = snapshot.workers[app.selectedAgentId].memory;
  if (snapshot.seniors?.[app.selectedAgentId]) memory = snapshot.seniors[app.selectedAgentId].memory;
  renderMemory(memory || {});
}

async function selectMemory(agentId) {
  app.selectedAgentId = agentId;
  $("memoryAgentSelect").value = agentId;
  try {
    const memory = await getJson(`/api/memory/${encodeURIComponent(agentId)}`);
    renderMemory(memory);
  } catch {
    refreshSelectedMemoryFromSnapshot();
  }
}

function renderMemory(memory) {
  $("memoryView").textContent = JSON.stringify(memory || {}, null, 2);
}

function exportExperimentData() {
  downloadUrl("/api/export/jsonl", "cybernh-events.jsonl");
  setTimeout(() => downloadUrl("/api/export/metrics.csv", "cybernh-metrics.csv"), 200);
}

function downloadUrl(url, filename) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

function percent(value) {
  return `${Math.round((Number(value) || 0) * 1000) / 10}%`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function titleCase(text) {
  return String(text || "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function classToken(value) {
  return String(value ?? "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
