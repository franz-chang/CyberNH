const {
  TILE_SIZE_M,
  PEAK_WINDOWS,
  CONGESTION_CONFIG,
  SHIFT_CONFIG,
  DAY_WORKER_INITIAL_POSITIONS,
  NIGHT_WORKER_INITIAL_POSITIONS,
  DEFAULT_WORKER_PROFILE,
  CARE_LEVEL_TASK_PROBABILITY,
  SENIOR_INITIAL_STATUS,
  DEMAND_INTENSITY_CONFIG,
  TASK_CATALOG,
  PEAK_TASK_POOL,
  CARE_MODE_PRIORITY_WEIGHTS,
  FATIGUE_CONFIG,
  EQUIPMENT_POOL_DEFAULT,
  DEFAULT_CONFIG,
} = require("./config");
const { createMapState, computeRoute, roomLookup, sameCell, isPassable } = require("./map");
const { SeededRng, clamp, percentile, gini } = require("./rng");
const { decideWorkerWithLlm, repairWorkerDecisionWithLlm } = require("./llmClient");

const WAITING_STATUSES = new Set(["waiting", "timeout_escalated", "waiting_for_equipment"]);
const ACTIVE_WAIT_STATUSES = new Set(["waiting", "timeout_escalated", "waiting_for_equipment", "assigned", "moving", "coordination_waiting"]);
const ACTIVE_TASK_STATUSES = new Set(["assigned", "moving", "coordination_waiting", "in_service"]);
const EXECUTABLE_WORKER_ACTIONS = ["accept_task", "join_two_person_task", "reject_all", "return_to_station", "continue_task", "finish"];
const MEMORY_LIMIT = 20;

class CyberNHSimulation {
  constructor() {
    this.subscribers = new Set();
    this.timer = null;
    this.tickInFlight = false;
    this.running = false;
    this.reset(DEFAULT_CONFIG);
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    fn({ type: "snapshot.full", payload: this.getSnapshot() });
    return () => this.subscribers.delete(fn);
  }

  publish(type = "snapshot.full", payload = this.getSnapshot()) {
    for (const fn of this.subscribers) {
      fn({ type, payload });
    }
  }

  reset(configPatch = {}) {
    this.stopTimer();
    this.config = normalizeConfig({ ...DEFAULT_CONFIG, ...configPatch });
    this.rng = new SeededRng(this.config.randomSeed);
    this.demandSeq = 0;
    this.eventSeq = 0;
    this.completedWaitingTicks = [];
    this.interruptedTaskCount = 0;
    this.equipmentOccupiedTicks = Object.fromEntries(Object.keys(EQUIPMENT_POOL_DEFAULT).map((key) => [key, 0]));
    this.nextAutoDemandTick = this.scheduleNextDemandTick(0);

    const map = createMapState();
    this.roomsByName = roomLookup(map);
    this.state = {
      version: "cybernh-v3",
      tick: 0,
      simulationDay: 1,
      currentTime: PEAK_WINDOWS[this.config.peakWindow].start,
      config: this.config,
      map,
      seniors: this.createSeniors(map),
      workers: this.createWorkers(map),
      assistant: this.createAssistant(),
      equipment: this.createEquipmentPool(),
      queue1: { id: "Senior-Agent Request Queue", demands: [] },
      queue2: { id: "Worker / Assistant Request Queue", items: [] },
      broadcastBoard: { seniorDemandRow: [], workerResourceRow: [], assistantMessage: "" },
      metrics: createEmptyMetrics(),
      eventLog: [],
    };

    this.logEvent("system.reset", "info", "Simulation reset", { config: this.config });
    this.updateDerivedState();
    this.publish();
    return this.getSnapshot();
  }

  updateConfig(patch = {}) {
    this.config = normalizeConfig({ ...this.config, ...patch });
    this.state.config = this.config;
    if (patch.randomSeed !== undefined) this.rng = new SeededRng(this.config.randomSeed + this.state.tick);
    this.refreshEffectiveSpeeds();
    this.updateDerivedState();
    this.logEvent("config.update", "info", "Configuration updated", patch);
    this.publish();
    if (this.running && patch.simSpeed !== undefined) this.restartTimer();
    return this.getSnapshot();
  }

  run(configPatch = {}) {
    if (Object.keys(configPatch).length) this.updateConfig(configPatch);
    this.running = true;
    this.state.control = { running: true, paused: false };
    this.restartTimer();
    this.logEvent("control.run", "info", "Simulation started", {});
    this.publish();
    return this.getSnapshot();
  }

  pause() {
    this.running = false;
    this.stopTimer();
    this.state.control = { running: false, paused: true };
    this.logEvent("control.pause", "info", "Simulation paused", {});
    this.publish();
    return this.getSnapshot();
  }

  stop() {
    this.running = false;
    this.stopTimer();
    this.state.control = { running: false, paused: false, stopped: true };
    this.logEvent("control.stop", "info", "Simulation stopped", {});
    this.publish();
    return this.getSnapshot();
  }

  restartTimer() {
    this.stopTimer();
    const intervalMs = Math.max(80, 1300 - this.config.simSpeed * 12);
    this.timer = setInterval(() => {
      if (!this.running) return;
      if (this.tickInFlight) return;
      if (this.state.tick >= this.config.totalDurationTicks) {
        this.pause();
        return;
      }
      this.tickInFlight = true;
      this.tick()
        .catch((error) => {
          this.running = false;
          this.stopTimer();
          this.state.control = { running: false, paused: true, error: error.message };
          this.logEvent("system.error", "error", error.message, { stack: error.stack });
          this.publish();
        })
        .finally(() => {
          this.tickInFlight = false;
        });
    }, intervalMs);
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.state.tick >= this.config.totalDurationTicks) {
      this.running = false;
      this.stopTimer();
      this.publish();
      return this.getSnapshot();
    }

    this.state.tick += 1;
    this.state.simulationDay = Math.floor(Math.max(0, this.state.tick - 1) / Math.max(1, this.config.durationTicks)) + 1;
    this.state.currentTime = addMinutesToTime(PEAK_WINDOWS[this.config.peakWindow].start, this.state.tick);

    this.incrementWaitingDemandState();
    this.generateAutomaticDemandsIfDue();
    this.processWorkerMovementAndRecovery();
    this.processInServiceDemands();
    await this.scheduleRuleDecisions();
    this.refreshEquipmentUtilizationTicks();
    this.updateDerivedState();
    this.publish("snapshot.full", this.getSnapshot());
    return this.getSnapshot();
  }

  manualGenerate(count = this.config.manualGenerateCount) {
    const generated = this.generateDemands(clamp(Number(count) || 3, 1, 8), "manual");
    this.updateDerivedState();
    this.publish();
    return { generated, snapshot: this.getSnapshot() };
  }

  createSeniors(map) {
    const seniorEntries = {};
    const targets = [...map.roomTargets].sort((a, b) => a.room.localeCompare(b.room));
    const careLevels = this.buildCareLevelList();
    for (let i = 0; i < 40; i += 1) {
      const target = targets[i];
      const careLevel = careLevels[i] || 1;
      const id = `Senior-${String(i + 1).padStart(2, "0")}`;
      const statusKey = `level${careLevel}`;
      const health = Math.round(this.rng.uniform(SENIOR_INITIAL_STATUS.health[statusKey].min, SENIOR_INITIAL_STATUS.health[statusKey].max));
      const mood = Math.round(this.rng.uniform(SENIOR_INITIAL_STATUS.mood[statusKey].min, SENIOR_INITIAL_STATUS.mood[statusKey].max));
      const patience = Math.round(this.rng.uniform(SENIOR_INITIAL_STATUS.patience[statusKey].min, SENIOR_INITIAL_STATUS.patience[statusKey].max));
      seniorEntries[id] = {
        id,
        role: "Senior-Agent",
        room: target.room,
        wing: target.wing,
        tile: target.tile,
        targetTile: target.targetTile,
        careLevel,
        health,
        mood,
        patience,
        currentStatus: SENIOR_INITIAL_STATUS.currentStatus,
        waitingTicks: 0,
        memory: {
          agentId: id,
          room: target.room,
          careLevel,
          demandQueue: {
            activeDemandId: null,
            waitingDemandIds: [],
            completedDemandIds: [],
          },
          statusMemory: {
            health,
            mood,
            patience,
            currentStatus: SENIOR_INITIAL_STATUS.currentStatus,
            waitingTicks: 0,
          },
          actionMemory: {
            lastAction: "null",
            lastServedBy: null,
            lastServiceTick: null,
          },
        },
      };
    }
    return seniorEntries;
  }

  buildCareLevelList() {
    let l1 = Math.round((this.config.careLevel1Ratio / 100) * 40);
    let l2 = Math.round((this.config.careLevel2Ratio / 100) * 40);
    let l3 = 40 - l1 - l2;
    if (!this.config.autoNormalizeCareLevel) {
      l3 = Math.round((this.config.careLevel3Ratio / 100) * 40);
    }
    const total = l1 + l2 + l3;
    if (total !== 40) {
      const diff = 40 - total;
      l3 += diff;
    }
    l1 = clamp(l1, 0, 40);
    l2 = clamp(l2, 0, 40 - l1);
    l3 = clamp(40 - l1 - l2, 0, 40);
    return [...Array(l1).fill(1), ...Array(l2).fill(2), ...Array(l3).fill(3)];
  }

  createWorkers(map) {
    const count = this.config.shift === "night_shift" ? this.config.nightWorkerCount : this.config.workerCount;
    const positions = this.config.shift === "night_shift" ? NIGHT_WORKER_INITIAL_POSITIONS : DAY_WORKER_INITIAL_POSITIONS;
    const wingAssignments = this.buildWorkerWingAssignments(count);
    const workers = {};
    for (let i = 0; i < count; i += 1) {
      const template = positions[i % positions.length];
      const id = positions[i]?.id || `Worker-${String(i + 1).padStart(2, "0")}`;
      const wing = wingAssignments[i] || template.wing;
      const baseWalkingSpeedMPerMin = this.rng.uniform(
        DEFAULT_WORKER_PROFILE.baseWalkingSpeedMPerMinMin,
        DEFAULT_WORKER_PROFILE.baseWalkingSpeedMPerMinMax
      );
      const initialTile = snapToPassable(map, template.tile);
      workers[id] = {
        id,
        role: "Worker-Agent",
        wing,
        tile: initialTile,
        locationLabel: template.label,
        status: "idle",
        baseWalkingSpeedMPerMin,
        effectiveSpeedMPerMin: baseWalkingSpeedMPerMin,
        fatigue: DEFAULT_WORKER_PROFILE.initialFatigue,
        currentTaskId: null,
        route: [],
        routeIndex: 0,
        routePurpose: null,
        remainingServiceTicks: null,
        maxConcurrentTasks: DEFAULT_WORKER_PROFILE.maxConcurrentTasksDefault,
        skillTags: ["light", "medium", "heavy"],
        totalWalkingDistanceM: 0,
        totalMovingTicks: 0,
        totalServiceTicks: 0,
        completedTaskCount: 0,
        heavyTaskCount: 0,
        stableSeniorIds: [],
        memory: null,
      };
      workers[id].memory = this.buildWorkerMemory(workers[id]);
    }
    return workers;
  }

  buildWorkerWingAssignments(count) {
    if (this.config.wingDistribution === "wing_a_heavy") {
      const aCount = Math.ceil(count * 0.67);
      return [...Array(aCount).fill("A"), ...Array(count - aCount).fill("B")];
    }
    if (this.config.wingDistribution === "wing_b_heavy") {
      const bCount = Math.ceil(count * 0.67);
      return [...Array(count - bCount).fill("A"), ...Array(bCount).fill("B")];
    }
    const aCount = Math.ceil(count / 2);
    return [...Array(aCount).fill("A"), ...Array(count - aCount).fill("B")];
  }

  createAssistant() {
    return {
      id: "Assistant-01",
      role: "Assistant-Agent",
      memory: {
        agentId: "Assistant-01",
        workerQueueSummary: { idle: [], moving: [], serving: [], unavailable: [] },
        seniorQueueSummary: { waiting: [], escalated: [], dangerous: [], coordinationWaiting: [] },
        systemLoadHistory: [],
        overallSchedulingProposal: {
          priority: "null",
          proposalType: "null",
          targetDemandIds: [],
          reason: "",
        },
      },
    };
  }

  createEquipmentPool() {
    return Object.fromEntries(
      Object.entries(EQUIPMENT_POOL_DEFAULT).map(([key, equipment]) => [
        key,
        {
          key,
          labelZh: equipment.labelZh,
          total: equipment.total,
          available: equipment.total,
          storageTile: { ...equipment.storageTile },
          occupiedBy: [],
        },
      ])
    );
  }

  generateAutomaticDemandsIfDue() {
    if (this.state.tick < this.nextAutoDemandTick) return;
    const pending = this.countPendingDemands();
    if (pending < this.config.maxPendingDemand) {
      const intensity = DEMAND_INTENSITY_CONFIG[this.config.demandIntensity];
      const count = this.rng.int(intensity.concurrentBurstMin, intensity.concurrentBurstMax);
      this.generateDemands(Math.min(count, this.config.maxPendingDemand - pending), "auto");
    }
    this.nextAutoDemandTick = this.scheduleNextDemandTick(this.state.tick);
  }

  scheduleNextDemandTick(fromTick) {
    const intensity = DEMAND_INTENSITY_CONFIG[this.config.demandIntensity] || DEMAND_INTENSITY_CONFIG.medium;
    return fromTick + this.rng.int(intensity.minIntervalTicks, intensity.maxIntervalTicks);
  }

  generateDemands(count, source = "manual") {
    const generated = [];
    for (let i = 0; i < count; i += 1) {
      if (this.countPendingDemands() >= this.config.maxPendingDemand) break;
      const senior = this.pickSeniorForDemand();
      const taskKey = this.pickTaskForSenior(senior);
      const task = TASK_CATALOG[taskKey];
      const durationTicks = Math.max(1, Math.round(this.rng.triangular(task.durationMin, task.durationMode, task.durationMax)));
      const demandId = `Q${String(++this.demandSeq).padStart(3, "0")}`;
      const requiredWorkers = this.resolveRequiredWorkers(taskKey, task, senior);
      const demand = {
        demandId,
        seniorId: senior.id,
        room: senior.room,
        wing: senior.wing,
        tile: { ...senior.targetTile },
        taskKey,
        taskLabelZh: task.labelZh,
        taskClass: task.taskClass,
        priorityLevel: task.basePriority,
        priorityScore: task.basePriority * 10,
        waitingTicks: 0,
        escalationCount: 0,
        requiredWorkers,
        requiredEquipment: [...task.requiredEquipment],
        assignedWorkerIds: [],
        arrivedWorkerIds: [],
        status: "waiting",
        createdTick: this.state.tick,
        serviceStartedTick: null,
        completedTick: null,
        waitingTicksAtServiceStart: null,
        durationTicks,
        remainingServiceTicks: null,
        coordinationWaitingTicks: 0,
        equipmentLocked: false,
        source,
      };
      this.state.queue1.demands.push(demand);
      senior.currentStatus = "waiting";
      senior.memory.demandQueue.activeDemandId ||= demandId;
      senior.memory.demandQueue.waitingDemandIds.push(demandId);
      senior.memory.actionMemory.lastAction = "call_worker";
      generated.push(demand);
      this.logEvent("demand.generated", "info", `${demandId} ${senior.room} ${task.labelZh}`, {
        demandId,
        seniorId: senior.id,
        taskKey,
        source,
      });
    }
    return generated;
  }

  resolveRequiredWorkers(taskKey, task, senior) {
    if (taskKey === "transfer") return this.config.twoPersonTaskEnabled ? 2 : 1;
    if (taskKey === "emergency_call" && this.config.twoPersonTaskEnabled && senior.careLevel === 3 && senior.health < 40) return 2;
    return task.requiredWorkers;
  }

  pickSeniorForDemand() {
    const seniors = Object.values(this.state.seniors);
    const weights = {};
    for (const senior of seniors) {
      const active = this.state.queue1.demands.some((demand) => demand.seniorId === senior.id && demand.status !== "completed");
      const careBoost = senior.careLevel * 0.5;
      weights[senior.id] = active ? 0.2 : 1 + careBoost;
    }
    const seniorId = this.rng.weightedPick(weights) || seniors[0].id;
    return this.state.seniors[seniorId];
  }

  pickTaskForSenior(senior) {
    const peakPool = PEAK_TASK_POOL[this.config.peakWindow];
    const careWeights = CARE_LEVEL_TASK_PROBABILITY[senior.careLevel];
    const adjusted = {};
    for (const [taskKey, peakWeight] of Object.entries(peakPool)) {
      const task = TASK_CATALOG[taskKey];
      adjusted[taskKey] = peakWeight * careWeights[task.taskClass];
    }
    return this.rng.weightedPick(adjusted) || "patrol";
  }

  incrementWaitingDemandState() {
    for (const demand of this.state.queue1.demands) {
      if (!ACTIVE_WAIT_STATUSES.has(demand.status)) continue;
      demand.waitingTicks += 1;
      const senior = this.state.seniors[demand.seniorId];
      senior.waitingTicks = Math.max(senior.waitingTicks, demand.waitingTicks);
      senior.patience = clamp(senior.patience - (senior.careLevel === 3 ? 0.35 : 0.22), 0, 100);
      senior.memory.statusMemory.waitingTicks = senior.waitingTicks;
      senior.memory.statusMemory.patience = Math.round(senior.patience);

      if (demand.status === "coordination_waiting") {
        demand.coordinationWaitingTicks += 1;
      }

      const threshold = this.config.escalationThresholdTicks * (demand.escalationCount + 1);
      if (demand.waitingTicks >= threshold) {
        demand.escalationCount += 1;
        demand.priorityLevel = clamp(demand.priorityLevel + 1, 1, 5);
        if (WAITING_STATUSES.has(demand.status)) demand.status = "timeout_escalated";
        senior.memory.actionMemory.lastAction = "complaint_broadcast";
        this.logEvent("demand.escalated", "warning", `${demand.demandId} waiting ${demand.waitingTicks}m`, {
          demandId: demand.demandId,
          waitingTicks: demand.waitingTicks,
        });
      }
    }
  }

  processWorkerMovementAndRecovery() {
    this.refreshEffectiveSpeeds();
    for (const worker of Object.values(this.state.workers)) {
      if (worker.status === "idle") {
        worker.fatigue = clamp(worker.fatigue - FATIGUE_CONFIG.idleRecoveryPerTick, 0, 1);
        continue;
      }
      if (worker.status === "unavailable") {
        worker.fatigue = clamp(worker.fatigue - FATIGUE_CONFIG.idleRecoveryPerTick, 0, 1);
        if (worker.fatigue <= 0.75) {
          worker.status = "idle";
          this.logEvent("worker.recovered", "info", `${worker.id} recovered from fatigue`, { workerId: worker.id });
        }
        continue;
      }
      if (worker.status !== "moving") continue;

      const movementBudgetTiles = Math.max(1, Math.floor(worker.effectiveSpeedMPerMin / TILE_SIZE_M));
      let movedSteps = 0;
      while (movedSteps < movementBudgetTiles && worker.routeIndex < worker.route.length - 1) {
        worker.routeIndex += 1;
        worker.tile = { ...worker.route[worker.routeIndex] };
        movedSteps += 1;
      }
      const movedDistanceM = movedSteps * TILE_SIZE_M;
      worker.totalWalkingDistanceM += movedDistanceM;
      worker.totalMovingTicks += movedSteps > 0 ? 1 : 0;
      worker.fatigue = clamp(worker.fatigue + (movedDistanceM / 50) * FATIGUE_CONFIG.walkingIncrementPer50M, 0, 1);

      if (worker.routeIndex >= worker.route.length - 1) {
        this.handleWorkerArrival(worker);
      }
    }
  }

  handleWorkerArrival(worker) {
    worker.route = [];
    worker.routeIndex = 0;
    if (worker.routePurpose === "return_station") {
      worker.status = worker.fatigue >= FATIGUE_CONFIG.unavailableThreshold ? "unavailable" : "idle";
      worker.locationLabel = "Nurse-Station";
      worker.routePurpose = null;
      return;
    }

    const demand = this.findDemand(worker.currentTaskId);
    if (!demand || demand.status === "completed") {
      worker.currentTaskId = null;
      worker.status = "idle";
      worker.routePurpose = null;
      return;
    }

    worker.locationLabel = demand.room;
    if (!demand.arrivedWorkerIds.includes(worker.id)) demand.arrivedWorkerIds.push(worker.id);
    if (demand.arrivedWorkerIds.length >= demand.requiredWorkers) {
      this.startService(demand);
    } else {
      worker.status = "coordination_waiting";
      demand.status = "coordination_waiting";
      this.logEvent("task.coordination_waiting", "info", `${demand.demandId} waiting for second worker`, {
        demandId: demand.demandId,
        workerId: worker.id,
      });
    }
  }

  processInServiceDemands() {
    for (const demand of this.state.queue1.demands) {
      if (demand.status !== "in_service") continue;
      demand.remainingServiceTicks -= 1;
      for (const workerId of demand.assignedWorkerIds) {
        const worker = this.state.workers[workerId];
        if (!worker) continue;
        worker.totalServiceTicks += 1;
        worker.remainingServiceTicks = Math.max(0, demand.remainingServiceTicks);
      }
      if (demand.remainingServiceTicks <= 0) {
        this.completeDemand(demand);
      }
    }
  }

  async scheduleRuleDecisions() {
    let activeCount = this.countActiveTasks();
    const idleWorkers = Object.values(this.state.workers)
      .filter((worker) => worker.status === "idle" && worker.fatigue < FATIGUE_CONFIG.unavailableThreshold)
      .sort((a, b) => a.fatigue - b.fatigue);

    for (const worker of idleWorkers) {
      if (activeCount >= this.config.maxActiveTask) break;
      const useWorkerLlm = this.config.agentDecisionMode !== "rule_only" && this.config.workerAgentLlmEnabled;
      let llmResult = null;
      let decision = useWorkerLlm ? (llmResult = await this.requiredLlmDecision(worker)).decision : this.ruleDecisionForWorker(worker);
      let result = decision.action === "reject_all" ? { ok: true } : this.applyWorkerDecision(decision);

      if (!result.ok && useWorkerLlm) {
        llmResult = await this.retryRejectedWorkerDecision(worker, llmResult, result.error || "unknown error");
        decision = llmResult.decision;
        result = decision.action === "reject_all" ? { ok: true } : this.applyWorkerDecision(decision);
        if (!result.ok) {
          throw new Error(`LLM decision application failed for ${worker.id}: ${result.error || "unknown error"}`);
        }
      }

      if (useWorkerLlm && llmResult) {
        this.recordAcceptedLlmDecision(worker.id, llmResult);
      }

      if (decision.action === "reject_all") continue;
      if (result.ok) activeCount = this.countActiveTasks();
    }
  }

  ruleDecisionForWorker(worker) {
    if (worker.status === "unavailable" || worker.fatigue >= FATIGUE_CONFIG.unavailableThreshold) {
      return {
        agent_id: worker.id,
        action: "reject_all",
        target_demand_id: null,
        reason: "疲劳过高，暂不接单",
        confidence: 0.95,
        memory_update: {},
      };
    }
    const candidates = this.candidateDemandsForWorker(worker).slice(0, 5);
    if (!candidates.length) {
      return {
        agent_id: worker.id,
        action: "reject_all",
        target_demand_id: null,
        reason: "当前没有可接需求",
        confidence: 0.8,
        memory_update: {},
      };
    }
    const best = candidates[0];
    return {
      agent_id: worker.id,
      action: best.demand.status === "coordination_waiting" ? "join_two_person_task" : "accept_task",
      target_demand_id: best.demand.demandId,
      reason: `规则评分最高：${best.demand.room} ${best.demand.taskLabelZh}，score=${best.score.toFixed(1)}`,
      confidence: 0.82,
      memory_update: { last_rule_score: Number(best.score.toFixed(2)) },
    };
  }

  async requiredLlmDecision(worker) {
    const observation = this.getWorkerObservation(worker.id);
    const llmResult = await decideWorkerWithLlm(observation, { decisionMode: this.config.agentDecisionMode });
    const eventPayload = {
      agent_id: worker.id,
      mode: this.config.agentDecisionMode,
      decision: null,
      llmInput: llmResult.requestPayload,
      llmReply: llmResult.ok ? llmResult.decision : null,
      rawReply: llmResult.rawReply,
      llmConfig: llmResult.config,
      llmError: llmResult.ok ? null : llmResult.error,
      source: llmResult.ok ? llmResult.config.provider : "LLM_ERROR",
    };

    if (!llmResult.ok) {
      this.pushQueue2Item({
        type: "agent.decision",
        agentId: worker.id,
        llmInput: llmResult.requestPayload,
        llmReply: null,
        rawReply: llmResult.rawReply,
        decision: null,
        source: "LLM_ERROR",
        llmError: llmResult.error,
        reason: `LLM decision failed: ${llmResult.error}`,
        tick: this.state.tick,
      });
      this.logEvent("agent.decision", "error", `${worker.id}: LLM decision failed: ${llmResult.error}`, eventPayload);
      throw new Error(`LLM decision failed for ${worker.id}: ${llmResult.error}`);
    }

    try {
      this.validateWorkerDecision(llmResult.decision);
    } catch (error) {
      eventPayload.llmError = `LLM decision rejected by simulator: ${error.message}`;
      eventPayload.source = "LLM_REJECTED";
      this.pushQueue2Item({
        type: "agent.decision",
        agentId: worker.id,
        llmInput: llmResult.requestPayload,
        llmReply: llmResult.decision,
        rawReply: llmResult.rawReply,
        decision: null,
        source: "LLM_REJECTED",
        llmError: eventPayload.llmError,
        reason: eventPayload.llmError,
        tick: this.state.tick,
      });
      this.logEvent("agent.decision", "error", `${worker.id}: ${eventPayload.llmError}`, eventPayload);
      throw new Error(`${eventPayload.llmError} for ${worker.id}`);
    }

    return { ...llmResult, observation };
  }

  async retryRejectedWorkerDecision(worker, llmResult, rejectionReason) {
    const observation = llmResult.observation || this.getWorkerObservation(worker.id);
    this.logEvent("agent.decision_retry", "warning", `${worker.id}: retrying after simulator rejection`, {
      agent_id: worker.id,
      previousDecision: llmResult.decision,
      rejectionReason,
    });

    const retry = await repairWorkerDecisionWithLlm(observation, {
      decisionMode: this.config.agentDecisionMode,
      originalRequestPayload: llmResult.requestPayload,
      invalidDecision: llmResult.decision,
      repairReason: `Previous decision was rejected by the simulator: ${rejectionReason}`,
      runtimeSupportedActions: EXECUTABLE_WORKER_ACTIONS,
    });

    const eventPayload = {
      agent_id: worker.id,
      mode: this.config.agentDecisionMode,
      decision: retry.ok ? retry.decision : null,
      llmInput: retry.requestPayload,
      llmReply: retry.ok ? retry.decision : null,
      rawReply: retry.rawReply,
      llmConfig: retry.config,
      llmError: retry.ok ? null : retry.error,
      source: retry.ok ? retry.config.provider : "LLM_RETRY_ERROR",
      repaired: true,
      repairReason: rejectionReason,
    };

    if (!retry.ok) {
      this.pushQueue2Item({
        type: "agent.decision",
        agentId: worker.id,
        llmInput: retry.requestPayload,
        llmReply: null,
        rawReply: retry.rawReply,
        decision: null,
        source: "LLM_RETRY_ERROR",
        llmError: retry.error,
        reason: `LLM retry failed: ${retry.error}`,
        tick: this.state.tick,
      });
      this.logEvent("agent.decision", "error", `${worker.id}: LLM retry failed: ${retry.error}`, eventPayload);
      throw new Error(`LLM retry failed for ${worker.id}: ${retry.error}`);
    }

    try {
      this.validateWorkerDecision(retry.decision);
    } catch (error) {
      eventPayload.llmError = `LLM retry rejected by simulator: ${error.message}`;
      eventPayload.source = "LLM_RETRY_REJECTED";
      this.pushQueue2Item({
        type: "agent.decision",
        agentId: worker.id,
        llmInput: retry.requestPayload,
        llmReply: retry.decision,
        rawReply: retry.rawReply,
        decision: null,
        source: "LLM_RETRY_REJECTED",
        llmError: eventPayload.llmError,
        reason: eventPayload.llmError,
        tick: this.state.tick,
      });
      this.logEvent("agent.decision", "error", `${worker.id}: ${eventPayload.llmError}`, eventPayload);
      throw new Error(`${eventPayload.llmError} for ${worker.id}`);
    }

    return { ...retry, observation };
  }

  recordAcceptedLlmDecision(workerId, llmResult) {
    const eventPayload = {
      agent_id: workerId,
      mode: this.config.agentDecisionMode,
      decision: llmResult.decision,
      llmInput: llmResult.requestPayload,
      llmReply: llmResult.decision,
      rawReply: llmResult.rawReply,
      llmConfig: llmResult.config,
      llmError: null,
      source: llmResult.config.provider,
      repaired: Boolean(llmResult.repaired),
      repairReason: llmResult.repairReason || null,
    };

    this.pushQueue2Item({
      type: "agent.decision",
      agentId: workerId,
      llmInput: llmResult.requestPayload,
      llmReply: llmResult.decision,
      rawReply: llmResult.rawReply,
      decision: llmResult.decision,
      source: llmResult.config.provider,
      llmError: null,
      reason: llmResult.decision.reason,
      tick: this.state.tick,
    });
    this.logEvent("agent.decision", "info", `${workerId}: ${llmResult.decision.reason}`, eventPayload);
  }

  candidateDemandsForWorker(worker) {
    const scored = [];
    for (const demand of this.state.queue1.demands) {
      if (!["waiting", "timeout_escalated", "waiting_for_equipment", "coordination_waiting"].includes(demand.status)) continue;
      if (demand.assignedWorkerIds.includes(worker.id)) continue;
      if (demand.assignedWorkerIds.length >= demand.requiredWorkers) continue;
      if (demand.status === "waiting_for_equipment" && !this.allEquipmentAvailable(demand)) continue;
      if (!this.allEquipmentAvailable(demand) && !demand.equipmentLocked) {
        demand.status = "waiting_for_equipment";
        continue;
      }
      const route = computeRoute(this.state.map, worker.tile, demand.tile);
      if (!route.reachable) continue;
      const score = this.calculatePriorityScore(demand, worker, route.distanceM);
      scored.push({ demand, score, route });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  applyWorkerDecision(decision) {
    try {
      this.validateWorkerDecision(decision);
      if (decision.action === "accept_task" || decision.action === "join_two_person_task") {
        const result = this.assignDemandToWorker(decision.agent_id, decision.target_demand_id);
        return result;
      }
      if (decision.action === "return_to_station") {
        return this.moveWorkerToStation(decision.agent_id);
      }
      if (decision.action === "reject_all" || decision.action === "finish") {
        return { ok: true };
      }
      if (decision.action === "continue_task") {
        return { ok: true };
      }
      return { ok: false, error: "Unsupported action" };
    } catch (error) {
      this.logEvent("agent.decision_rejected", "warning", `${decision.agent_id}: ${error.message}`, { decision });
      return { ok: false, error: error.message };
    }
  }

  validateWorkerDecision(decision) {
    const worker = this.state.workers[decision.agent_id];
    if (!worker) throw new Error("Unknown worker");
    if (worker.status === "unavailable" && decision.action === "accept_task") throw new Error("Unavailable worker cannot accept task");
    if (decision.target_demand_id) {
      const demand = this.findDemand(decision.target_demand_id);
      if (!demand) throw new Error("Unknown demand");
      if (demand.status === "completed") throw new Error("Completed demand cannot be selected");
    }
    if (decision.action === "accept_task" || decision.action === "join_two_person_task") {
      const demand = this.findDemand(decision.target_demand_id);
      if (!demand) throw new Error("Unknown demand");
      if (!this.allEquipmentAvailable(demand) && !demand.equipmentLocked) throw new Error("Required equipment unavailable");
      if (demand.assignedWorkerIds.length >= demand.requiredWorkers) throw new Error("Demand already has enough workers");
    }
  }

  assignDemandToWorker(workerId, demandId) {
    const worker = this.state.workers[workerId];
    const demand = this.findDemand(demandId);
    const route = computeRoute(this.state.map, worker.tile, demand.tile);
    if (!route.reachable) return { ok: false, error: "unreachable demand" };

    if (!demand.equipmentLocked && demand.requiredEquipment.length) {
      this.lockEquipment(demand, workerId);
    }
    if (!demand.assignedWorkerIds.includes(workerId)) demand.assignedWorkerIds.push(workerId);
    worker.currentTaskId = demandId;
    worker.route = route.path;
    worker.routeIndex = 0;
    worker.status = sameCell(worker.tile, demand.tile) ? "coordination_waiting" : "moving";
    worker.routePurpose = "serve_demand";
    worker.remainingServiceTicks = null;
    demand.status = demand.requiredWorkers > 1 && demand.arrivedWorkerIds.length > 0 ? "coordination_waiting" : "moving";

    this.pushQueue2Item({
      type: "worker.accepted",
      agentId: workerId,
      demandId,
      reason: `${workerId} moving to ${demand.room}`,
      tick: this.state.tick,
    });
    this.logEvent("task.assigned", "info", `${workerId} -> ${demandId} ${demand.room}`, {
      workerId,
      demandId,
      distanceM: route.distanceM,
    });

    if (sameCell(worker.tile, demand.tile)) this.handleWorkerArrival(worker);
    return { ok: true };
  }

  moveWorkerToStation(workerId) {
    const worker = this.state.workers[workerId];
    const target = { x: 17, y: 22 };
    const route = computeRoute(this.state.map, worker.tile, target);
    worker.currentTaskId = null;
    worker.route = route.path;
    worker.routeIndex = 0;
    worker.routePurpose = "return_station";
    worker.status = route.reachable && route.path.length > 1 ? "moving" : "idle";
    return { ok: true };
  }

  startService(demand) {
    if (demand.status === "in_service") return;
    demand.status = "in_service";
    demand.serviceStartedTick = this.state.tick;
    demand.waitingTicksAtServiceStart = demand.waitingTicks;
    demand.remainingServiceTicks = demand.durationTicks;
    const senior = this.state.seniors[demand.seniorId];
    senior.currentStatus = "in_service";
    senior.memory.statusMemory.currentStatus = "in_service";
    for (const workerId of demand.assignedWorkerIds) {
      const worker = this.state.workers[workerId];
      if (!worker) continue;
      worker.status = "serving";
      worker.remainingServiceTicks = demand.remainingServiceTicks;
      worker.locationLabel = demand.room;
    }
    this.completedWaitingTicks.push(demand.waitingTicksAtServiceStart);
    this.logEvent("task.started", "info", `${demand.demandId} service started`, {
      demandId: demand.demandId,
      workers: demand.assignedWorkerIds,
      waitingTicks: demand.waitingTicksAtServiceStart,
    });
  }

  completeDemand(demand) {
    const task = TASK_CATALOG[demand.taskKey];
    demand.status = "completed";
    demand.completedTick = this.state.tick;
    demand.remainingServiceTicks = 0;
    this.releaseEquipment(demand);
    const senior = this.state.seniors[demand.seniorId];
    senior.health = clamp(senior.health + task.healthDeltaOnComplete, 0, 100);
    senior.mood = clamp(senior.mood + task.moodDeltaOnComplete, 0, 100);
    senior.patience = clamp(senior.patience + task.patienceRestore, 0, 100);
    senior.currentStatus = "idle";
    senior.waitingTicks = 0;
    senior.memory.demandQueue.activeDemandId = null;
    senior.memory.demandQueue.waitingDemandIds = senior.memory.demandQueue.waitingDemandIds.filter((id) => id !== demand.demandId);
    senior.memory.demandQueue.completedDemandIds.push(demand.demandId);
    senior.memory.statusMemory = {
      health: Math.round(senior.health),
      mood: Math.round(senior.mood),
      patience: Math.round(senior.patience),
      currentStatus: "idle",
      waitingTicks: 0,
    };
    senior.memory.actionMemory.lastAction = "feedback_after_service";
    senior.memory.actionMemory.lastServedBy = demand.assignedWorkerIds[0] || null;
    senior.memory.actionMemory.lastServiceTick = this.state.tick;

    for (const workerId of demand.assignedWorkerIds) {
      const worker = this.state.workers[workerId];
      if (!worker) continue;
      worker.completedTaskCount += 1;
      worker.fatigue = clamp(worker.fatigue + task.fatigueIncrement, 0, 1);
      if (task.taskClass === "heavy") worker.heavyTaskCount += 1;
      if (!worker.stableSeniorIds.includes(demand.seniorId)) {
        worker.stableSeniorIds.push(demand.seniorId);
        worker.stableSeniorIds = worker.stableSeniorIds.slice(-6);
      }
      worker.currentTaskId = null;
      worker.remainingServiceTicks = null;
      worker.status = worker.fatigue >= FATIGUE_CONFIG.unavailableThreshold ? "unavailable" : "idle";
      worker.memory.taskQueue.doing = null;
      worker.memory.taskQueue.done.push(demand.demandId);
      worker.memory.taskQueue.done = worker.memory.taskQueue.done.slice(-MEMORY_LIMIT);
      worker.memory.expMemory.stableSeniorIds = [...worker.stableSeniorIds];
    }
    this.logEvent("task.completed", "success", `${demand.demandId} completed`, {
      demandId: demand.demandId,
      workers: demand.assignedWorkerIds,
      fatigueIncrement: task.fatigueIncrement,
    });
  }

  allEquipmentAvailable(demand) {
    if (demand.equipmentLocked) return true;
    return demand.requiredEquipment.every((key) => this.state.equipment[key]?.available > 0);
  }

  lockEquipment(demand, workerId) {
    for (const key of demand.requiredEquipment) {
      const equipment = this.state.equipment[key];
      if (!equipment || equipment.available <= 0) throw new Error(`${key} unavailable`);
      equipment.available -= 1;
      equipment.occupiedBy.push({
        demandId: demand.demandId,
        workerId,
        releaseTickEstimate: this.state.tick + demand.durationTicks + Math.ceil(demand.waitingTicks / 2),
      });
    }
    demand.equipmentLocked = true;
  }

  releaseEquipment(demand) {
    if (!demand.equipmentLocked) return;
    for (const key of demand.requiredEquipment) {
      const equipment = this.state.equipment[key];
      if (!equipment) continue;
      equipment.occupiedBy = equipment.occupiedBy.filter((item) => item.demandId !== demand.demandId);
      equipment.available = clamp(equipment.available + 1, 0, equipment.total);
    }
    demand.equipmentLocked = false;
  }

  calculatePriorityScore(demand, worker, distanceM = null) {
    const senior = this.state.seniors[demand.seniorId];
    const task = TASK_CATALOG[demand.taskKey];
    const weights = CARE_MODE_PRIORITY_WEIGHTS[this.config.careMode];
    const routeDistance = distanceM ?? computeRoute(this.state.map, worker.tile, demand.tile).distanceM;
    const equipmentPenalty = this.allEquipmentAvailable(demand) || demand.equipmentLocked ? 0 : 1;
    const relationalBonus = worker.stableSeniorIds.includes(senior.id) ? 1 : 0;
    const score =
      clamp((100 - senior.health) / 100, 0, 1) * weights.healthRisk +
      clamp((100 - senior.patience) / 100, 0, 1) * weights.patienceRisk +
      (task.basePriority / 5) * weights.taskUrgency +
      clamp(demand.waitingTicks / this.config.escalationThresholdTicks, 0, 1.5) * weights.waitingTimeRisk +
      (senior.careLevel / 3) * weights.careLevelWeight +
      (demand.escalationCount > 0 ? 1 : 0) * weights.escalationBonus +
      relationalBonus * weights.relationalBonus -
      clamp(routeDistance / 120, 0, 1) * weights.distanceCost -
      worker.fatigue * weights.fatiguePenalty -
      equipmentPenalty * weights.equipmentPenalty;
    const wingFit = worker.wing === "FULL" || worker.wing === demand.wing ? 4 : -2;
    const heavyFatiguePenalty = task.taskClass === "heavy" && worker.fatigue > FATIGUE_CONFIG.warningThreshold ? -8 : 0;
    return clamp(score * 100 + wingFit + heavyFatiguePenalty, 0, 100);
  }

  refreshEffectiveSpeeds() {
    const congestionFactor = 1 - CONGESTION_CONFIG[this.config.congestion].speedReductionRatio;
    for (const worker of Object.values(this.state.workers || {})) {
      const fatigueFactor = 1 - 0.4 * worker.fatigue;
      worker.effectiveSpeedMPerMin = clamp(worker.baseWalkingSpeedMPerMin * congestionFactor * fatigueFactor, 20, 70);
    }
  }

  refreshEquipmentUtilizationTicks() {
    for (const [key, equipment] of Object.entries(this.state.equipment)) {
      this.equipmentOccupiedTicks[key] += equipment.total - equipment.available;
    }
  }

  updateDerivedState() {
    this.refreshEffectiveSpeeds();
    this.refreshMemories();
    this.updateDemandScores();
    const systemLoad = this.calculateSystemLoad();
    this.updateBroadcastBoard(systemLoad);
    this.updateAssistantMemory(systemLoad);
    this.state.metrics = this.calculateMetrics();
  }

  updateDemandScores() {
    const workers = Object.values(this.state.workers);
    for (const demand of this.state.queue1.demands) {
      if (demand.status === "completed") continue;
      let best = demand.priorityLevel * 10;
      for (const worker of workers) {
        if (worker.status === "unavailable") continue;
        best = Math.max(best, this.calculatePriorityScore(demand, worker));
      }
      demand.priorityScore = Number(best.toFixed(2));
    }
  }

  updateBroadcastBoard(systemLoad) {
    const seniorDemandRow = this.state.queue1.demands
      .filter((demand) => demand.status !== "completed")
      .sort((a, b) => b.priorityScore - a.priorityScore || b.waitingTicks - a.waitingTicks)
      .slice(0, 12)
      .map((demand) => ({
        demandId: demand.demandId,
        seniorId: demand.seniorId,
        room: demand.room,
        wing: demand.wing,
        taskKey: demand.taskKey,
        taskLabelZh: demand.taskLabelZh,
        taskClass: demand.taskClass,
        priorityLevel: demand.priorityLevel,
        priorityScore: demand.priorityScore,
        waitingTicks: demand.waitingTicks,
        escalationCount: demand.escalationCount,
        requiredWorkers: demand.requiredWorkers,
        requiredEquipment: demand.requiredEquipment,
        assignedWorkerIds: demand.assignedWorkerIds,
        status: demand.status,
      }));

    const workerResourceRow = Object.values(this.state.workers).map((worker) => ({
      workerId: worker.id,
      wing: worker.wing,
      tile: worker.tile,
      locationLabel: worker.locationLabel,
      status: worker.status,
      fatigue: Number(worker.fatigue.toFixed(3)),
      effectiveSpeedMPerMin: Number(worker.effectiveSpeedMPerMin.toFixed(1)),
      currentTaskId: worker.currentTaskId,
      remainingServiceTicks: worker.remainingServiceTicks,
      skillTags: worker.skillTags,
    }));

    this.state.broadcastBoard = {
      seniorDemandRow,
      workerResourceRow,
      assistantMessage: this.assistantMessageForLoad(systemLoad),
    };
  }

  assistantMessageForLoad(systemLoad) {
    const waitingEquipment = this.state.queue1.demands.filter((demand) => demand.status === "waiting_for_equipment");
    const coordination = this.state.queue1.demands.filter((demand) => demand.status === "coordination_waiting" && demand.coordinationWaitingTicks >= 3);
    if (waitingEquipment.length) return `Assistant: equipment shortage for ${waitingEquipment.map((d) => d.demandId).join(", ")}`;
    if (coordination.length) return `Assistant: coordination warning ${coordination.map((d) => d.demandId).join(", ")}`;
    if (systemLoad === "risk") return "Assistant: Risk load / prioritize escalated and high-care demands";
    if (systemLoad === "overloaded") return "Assistant: Overloaded / reduce travel and finish active tasks";
    if (systemLoad === "high") return "Assistant: High Load / prioritize urgent waiting demands";
    return "Assistant: Normal load";
  }

  updateAssistantMemory(systemLoad) {
    const workers = Object.values(this.state.workers);
    const demands = this.state.queue1.demands;
    const workerQueueSummary = {
      idle: workers.filter((w) => w.status === "idle").map((w) => w.id),
      moving: workers.filter((w) => w.status === "moving").map((w) => w.id),
      serving: workers.filter((w) => w.status === "serving").map((w) => w.id),
      unavailable: workers.filter((w) => w.status === "unavailable").map((w) => w.id),
    };
    const seniorQueueSummary = {
      waiting: demands.filter((d) => WAITING_STATUSES.has(d.status)).map((d) => d.demandId),
      escalated: demands.filter((d) => d.escalationCount > 0 && d.status !== "completed").map((d) => d.demandId),
      dangerous: demands
        .filter((d) => {
          const senior = this.state.seniors[d.seniorId];
          return d.status !== "completed" && senior.careLevel === 3 && senior.health < 35;
        })
        .map((d) => d.demandId),
      coordinationWaiting: demands.filter((d) => d.status === "coordination_waiting").map((d) => d.demandId),
    };
    const memory = this.state.assistant.memory;
    memory.workerQueueSummary = workerQueueSummary;
    memory.seniorQueueSummary = seniorQueueSummary;
    memory.systemLoadHistory.push({
      tick: this.state.tick,
      load: systemLoad,
      reason: this.state.broadcastBoard.assistantMessage,
    });
    memory.systemLoadHistory = memory.systemLoadHistory.slice(-MEMORY_LIMIT);
    memory.overallSchedulingProposal = this.assistantProposal(systemLoad, seniorQueueSummary);
  }

  assistantProposal(systemLoad, seniorQueueSummary) {
    if (seniorQueueSummary.dangerous.length || seniorQueueSummary.escalated.length >= 3) {
      return {
        priority: "highest",
        proposalType: "emergency_priority",
        targetDemandIds: [...seniorQueueSummary.dangerous, ...seniorQueueSummary.escalated].slice(0, 5),
        reason: "存在高风险或多条超时需求",
      };
    }
    if (systemLoad === "overloaded" || systemLoad === "high") {
      return {
        priority: "high",
        proposalType: "load_warning",
        targetDemandIds: seniorQueueSummary.waiting.slice(0, 5),
        reason: "等待队列压力较高",
      };
    }
    return {
      priority: "null",
      proposalType: "null",
      targetDemandIds: [],
      reason: "系统负荷正常",
    };
  }

  calculateSystemLoad() {
    const pending = this.state.queue1.demands.filter((demand) => demand.status === "waiting" || demand.status === "timeout_escalated").length;
    const idle = Object.values(this.state.workers).filter((worker) => worker.status === "idle").length;
    const timeoutRisk = this.state.queue1.demands.filter((demand) => demand.waitingTicks >= this.config.escalationThresholdTicks && demand.status !== "completed").length;
    const highCareWaiting = this.state.queue1.demands.filter((demand) => {
      const senior = this.state.seniors[demand.seniorId];
      return senior.careLevel === 3 && WAITING_STATUSES.has(demand.status);
    }).length;
    if (timeoutRisk >= 3 || highCareWaiting >= 4) return "risk";
    if (pending >= 8 && idle === 0) return "overloaded";
    if (pending >= 5 && idle <= 1) return "high";
    if (pending <= 2 && idle >= 3) return "low";
    return "normal";
  }

  calculateMetrics() {
    const demands = this.state.queue1.demands;
    const workers = Object.values(this.state.workers);
    const completed = demands.filter((demand) => demand.status === "completed");
    const generatedDemandCount = demands.length;
    const completedDemandCount = completed.length;
    const activeDemandCount = demands.filter((demand) => ACTIVE_TASK_STATUSES.has(demand.status)).length;
    const pendingDemandCount = demands.filter((demand) => WAITING_STATUSES.has(demand.status)).length;
    const waitingValues = this.completedWaitingTicks;
    const walkingDistanceByWorker = Object.fromEntries(workers.map((worker) => [worker.id, Number(worker.totalWalkingDistanceM.toFixed(1))]));
    const taskProcessingTicksByWorker = Object.fromEntries(workers.map((worker) => [worker.id, worker.totalServiceTicks]));
    const caregiverUtilization = Object.fromEntries(
      workers.map((worker) => [worker.id, Number(((worker.totalMovingTicks + worker.totalServiceTicks) / Math.max(1, this.state.tick)).toFixed(3))])
    );
    const heavyTaskCountByWorker = Object.fromEntries(workers.map((worker) => [worker.id, worker.heavyTaskCount]));
    const equipmentUtilization = Object.fromEntries(
      Object.entries(this.state.equipment).map(([key, equipment]) => [
        key,
        Number((this.equipmentOccupiedTicks[key] / Math.max(1, this.state.tick * equipment.total)).toFixed(3)),
      ])
    );
    return {
      generatedDemandCount,
      completedDemandCount,
      activeDemandCount,
      pendingDemandCount,
      averageWaitingTicks: Number((waitingValues.reduce((sum, value) => sum + value, 0) / Math.max(1, waitingValues.length)).toFixed(2)),
      p95WaitingTicks: percentile(waitingValues, 0.95),
      timeoutRate: Number((demands.filter((demand) => demand.waitingTicks > this.config.escalationThresholdTicks).length / Math.max(1, generatedDemandCount)).toFixed(3)),
      escalationCount: demands.reduce((sum, demand) => sum + demand.escalationCount, 0),
      totalWalkingDistanceM: Number(workers.reduce((sum, worker) => sum + worker.totalWalkingDistanceM, 0).toFixed(1)),
      walkingDistanceByWorker,
      totalTaskProcessingTicks: workers.reduce((sum, worker) => sum + worker.totalServiceTicks, 0),
      taskProcessingTicksByWorker,
      caregiverUtilization,
      heavyTaskCountByWorker,
      heavyTaskGini: Number(gini(Object.values(heavyTaskCountByWorker)).toFixed(3)),
      coordinationWaitingTicksTotal: demands.reduce((sum, demand) => sum + demand.coordinationWaitingTicks, 0),
      interruptedTaskCount: this.interruptedTaskCount,
      equipmentUtilization,
      taskCompletionRate: Number((completedDemandCount / Math.max(1, generatedDemandCount)).toFixed(3)),
      systemLoad: this.calculateSystemLoad(),
    };
  }

  refreshMemories() {
    for (const worker of Object.values(this.state.workers || {})) {
      worker.memory = this.buildWorkerMemory(worker);
    }
    for (const senior of Object.values(this.state.seniors || {})) {
      senior.memory.statusMemory = {
        health: Math.round(senior.health),
        mood: Math.round(senior.mood),
        patience: Math.round(senior.patience),
        currentStatus: senior.currentStatus,
        waitingTicks: senior.waitingTicks,
      };
    }
  }

  buildWorkerMemory(worker) {
    const existing = worker.memory || {};
    return {
      agentId: worker.id,
      publicMemory: {
        wing: worker.wing,
        currentTile: worker.tile,
        status: worker.status,
        fatigue: Number(worker.fatigue.toFixed(3)),
        effectiveSpeedMPerMin: Number(worker.effectiveSpeedMPerMin.toFixed(1)),
        currentTaskId: worker.currentTaskId,
        completedTaskCount: worker.completedTaskCount,
        totalWalkingDistanceM: Number(worker.totalWalkingDistanceM.toFixed(1)),
        totalServiceTicks: worker.totalServiceTicks,
      },
      taskQueue: {
        todo: this.state?.queue1?.demands
          ?.filter((demand) => demand.assignedWorkerIds.includes(worker.id) && demand.status !== "completed")
          .map((demand) => demand.demandId) || [],
        doing: worker.currentTaskId,
        done: existing.taskQueue?.done || [],
        paused: existing.taskQueue?.paused || [],
        abandoned: existing.taskQueue?.abandoned || [],
      },
      envMemory: {
        knownEquipment: Object.fromEntries(Object.entries(this.state?.equipment || {}).map(([key, equipment]) => [key, equipment.available])),
        congestedAreas: [CONGESTION_CONFIG[this.config.congestion].visualBadge],
        nearbyPendingDemands: this.state?.queue1?.demands
          ?.filter((demand) => WAITING_STATUSES.has(demand.status))
          .slice(0, 5)
          .map((demand) => demand.demandId) || [],
      },
      expMemory: {
        stableSeniorIds: [...worker.stableSeniorIds],
        recentDecisionReasons: (existing.expMemory?.recentDecisionReasons || []).slice(-MEMORY_LIMIT),
        learnedPreferenceTags: existing.expMemory?.learnedPreferenceTags || [],
      },
    };
  }

  getMemory(agentId) {
    if (agentId === "Assistant-01") return this.state.assistant.memory;
    if (this.state.workers[agentId]) return this.state.workers[agentId].memory;
    if (this.state.seniors[agentId]) return this.state.seniors[agentId].memory;
    return null;
  }

  patchMemory(agentId, patch = {}) {
    const target = this.getMemory(agentId);
    if (!target) return null;
    deepMerge(target, patch);
    this.logEvent("memory.patch", "info", `${agentId} memory patched`, { agentId, patch });
    this.publish("agent.memory.updated", { agentId, memory: target });
    this.publish();
    return target;
  }

  getWorkerObservation(workerId) {
    const worker = this.state.workers[workerId];
    if (!worker) return null;
    const candidateDemands = this.candidateDemandsForWorker(worker)
      .slice(0, 5)
      .map(({ demand, route, score }) => ({
        demandId: demand.demandId,
        room: demand.room,
        taskLabelZh: demand.taskLabelZh,
        taskClass: demand.taskClass,
        status: demand.status,
        seniorCareLevel: this.state.seniors[demand.seniorId]?.careLevel,
        priorityLevel: demand.priorityLevel,
        priorityScore: Number(score.toFixed(2)),
        waitingTicks: demand.waitingTicks,
        requiredWorkers: demand.requiredWorkers,
        assignedWorkerIds: demand.assignedWorkerIds,
        arrivedWorkerIds: demand.arrivedWorkerIds,
        requiredEquipment: demand.requiredEquipment,
        equipmentAvailable: this.allEquipmentAvailable(demand),
        routeDistanceM: route.distanceM,
        estimatedArrivalTicks: Math.ceil(route.distanceM / worker.effectiveSpeedMPerMin),
        stableRelation: worker.stableSeniorIds.includes(demand.seniorId),
      }));
    return {
      agentType: "Worker-Agent",
      agentId: workerId,
      tick: this.state.tick,
      currentTime: this.state.currentTime,
      careMode: this.config.careMode,
      workerMemory: worker.memory,
      panelState: {
        running: this.running,
        paused: !this.running,
        tick: this.state.tick,
        durationTicks: this.config.durationTicks,
        simulationDays: this.config.simulationDays,
        totalDurationTicks: this.config.totalDurationTicks,
        simSpeed: this.config.simSpeed,
        randomSeed: this.config.randomSeed,
      },
      broadcastBoard: this.state.broadcastBoard,
      candidateDemands,
      constraints: {
        canAcceptNewTask: worker.status === "idle" && worker.fatigue < FATIGUE_CONFIG.unavailableThreshold,
        canPreemptCurrentTask: false,
        fatigueWarning: worker.fatigue > FATIGUE_CONFIG.warningThreshold,
        unavailable: worker.status === "unavailable",
      },
    };
  }

  getAssistantObservation() {
    return {
      agentType: "Assistant-Agent",
      tick: this.state.tick,
      currentTime: this.state.currentTime,
      careMode: this.config.careMode,
      seniorDemandRow: this.state.broadcastBoard.seniorDemandRow,
      workerResourceRow: this.state.broadcastBoard.workerResourceRow,
      equipment: this.state.equipment,
      metrics: this.state.metrics,
      systemLoad: this.calculateSystemLoad(),
    };
  }

  findDemand(demandId) {
    return this.state.queue1.demands.find((demand) => demand.demandId === demandId);
  }

  countPendingDemands() {
    return this.state.queue1.demands.filter((demand) => WAITING_STATUSES.has(demand.status)).length;
  }

  countActiveTasks() {
    return this.state.queue1.demands.filter((demand) => ACTIVE_TASK_STATUSES.has(demand.status)).length;
  }

  pushQueue2Item(item) {
    this.state.queue2.items.push(item);
    this.state.queue2.items = this.state.queue2.items.slice(-100);
  }

  logEvent(type, severity, message, payload = {}) {
    if (!this.state) return;
    const item = {
      id: `E${String(++this.eventSeq).padStart(4, "0")}`,
      tick: this.state.tick,
      time: this.state.currentTime,
      type,
      severity,
      message,
      payload,
    };
    this.state.eventLog.unshift(item);
    this.state.eventLog = this.state.eventLog.slice(0, 500);
    this.publish("log.event", item);
  }

  exportJsonl() {
    return [...this.state.eventLog]
      .reverse()
      .map((item) => JSON.stringify(item))
      .join("\n");
  }

  exportMetricsCsv() {
    const metrics = this.state.metrics;
    const rows = [
      ["metric", "value"],
      ["tick", this.state.tick],
      ["generatedDemandCount", metrics.generatedDemandCount],
      ["completedDemandCount", metrics.completedDemandCount],
      ["activeDemandCount", metrics.activeDemandCount],
      ["pendingDemandCount", metrics.pendingDemandCount],
      ["averageWaitingTicks", metrics.averageWaitingTicks],
      ["p95WaitingTicks", metrics.p95WaitingTicks],
      ["timeoutRate", metrics.timeoutRate],
      ["escalationCount", metrics.escalationCount],
      ["totalWalkingDistanceM", metrics.totalWalkingDistanceM],
      ["totalTaskProcessingTicks", metrics.totalTaskProcessingTicks],
      ["heavyTaskGini", metrics.heavyTaskGini],
      ["coordinationWaitingTicksTotal", metrics.coordinationWaitingTicksTotal],
      ["interruptedTaskCount", metrics.interruptedTaskCount],
      ["taskCompletionRate", metrics.taskCompletionRate],
      ["systemLoad", metrics.systemLoad],
    ];
    return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
  }

  getSnapshot() {
    return this.state;
  }
}

function createEmptyMetrics() {
  return {
    generatedDemandCount: 0,
    completedDemandCount: 0,
    activeDemandCount: 0,
    pendingDemandCount: 0,
    averageWaitingTicks: 0,
    p95WaitingTicks: 0,
    timeoutRate: 0,
    escalationCount: 0,
    totalWalkingDistanceM: 0,
    walkingDistanceByWorker: {},
    totalTaskProcessingTicks: 0,
    taskProcessingTicksByWorker: {},
    caregiverUtilization: {},
    heavyTaskCountByWorker: {},
    heavyTaskGini: 0,
    coordinationWaitingTicksTotal: 0,
    interruptedTaskCount: 0,
    equipmentUtilization: {},
    taskCompletionRate: 0,
    systemLoad: "low",
  };
}

function normalizeConfig(input) {
  const config = { ...input };
  config.randomSeed = clamp(parseInt(config.randomSeed, 10) || 42, 0, 999999);
  config.durationTicks = clamp(parseInt(config.durationTicks, 10) || 120, 60, 1440);
  config.simulationDays = clamp(parseInt(config.simulationDays, 10) || 1, 1, 14);
  config.totalDurationTicks = config.durationTicks * config.simulationDays;
  config.simSpeed = clamp(parseInt(config.simSpeed, 10) || 40, 1, 100);
  config.workerCount = clamp(parseInt(config.workerCount, 10) || 6, 2, 8);
  config.nightWorkerCount = clamp(parseInt(config.nightWorkerCount, 10) || 2, 2, 4);
  config.oneToOneDay = clamp(parseInt(config.oneToOneDay, 10) || 6, 0, 8);
  config.oneToOneFullDay = clamp(parseInt(config.oneToOneFullDay, 10) || 2, 0, 4);
  config.seniorCount = 40;
  config.careLevel1Ratio = clamp(parseInt(config.careLevel1Ratio, 10) || 40, 0, 100);
  config.careLevel2Ratio = clamp(parseInt(config.careLevel2Ratio, 10) || 35, 0, 100);
  config.careLevel3Ratio = clamp(parseInt(config.careLevel3Ratio, 10) || 25, 0, 100);
  if (config.autoNormalizeCareLevel) {
    const sum = config.careLevel1Ratio + config.careLevel2Ratio + config.careLevel3Ratio || 100;
    config.careLevel1Ratio = Math.round((config.careLevel1Ratio / sum) * 100);
    config.careLevel2Ratio = Math.round((config.careLevel2Ratio / sum) * 100);
    config.careLevel3Ratio = 100 - config.careLevel1Ratio - config.careLevel2Ratio;
  }
  config.manualGenerateCount = clamp(parseInt(config.manualGenerateCount, 10) || 3, 1, 8);
  config.escalationThresholdTicks = clamp(parseInt(config.escalationThresholdTicks, 10) || 10, 8, 12);
  config.maxPendingDemand = clamp(parseInt(config.maxPendingDemand, 10) || 10, 3, 20);
  config.maxActiveTask = clamp(parseInt(config.maxActiveTask, 10) || 6, 1, 8);
  config.tickMinutes = 1;
  config.layout = "u_shape_40_rooms";
  config.twoPersonTaskEnabled = Boolean(config.twoPersonTaskEnabled);
  config.interruptionEnabled = Boolean(config.interruptionEnabled);
  config.assistantAgentEnabled = Boolean(config.assistantAgentEnabled);
  config.seniorAgentLlmEnabled = Boolean(config.seniorAgentLlmEnabled);
  config.workerAgentLlmEnabled = Boolean(config.workerAgentLlmEnabled);
  config.agentDecisionMode = ["rule_only", "llm_required", "deepseek_api", "local_deepseek_v4_flash"].includes(config.agentDecisionMode)
    ? config.agentDecisionMode
    : "llm_required";
  return config;
}

function addMinutesToTime(timeText, minutes) {
  const [hour, minute] = timeText.split(":").map(Number);
  const total = hour * 60 + minute + minutes;
  const normalized = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function deepMerge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      target[key] ||= {};
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function snapToPassable(map, tile) {
  if (isPassable(map, tile)) return { ...tile };
  const visited = new Set();
  const queue = [{ ...tile }];
  const key = (item) => `${item.x},${item.y}`;
  visited.add(key(tile));
  const dirs = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
  ];
  while (queue.length) {
    const current = queue.shift();
    for (const dir of dirs) {
      const next = { x: current.x + dir.x, y: current.y + dir.y };
      const nextKey = key(next);
      if (visited.has(nextKey)) continue;
      visited.add(nextKey);
      if (isPassable(map, next)) return next;
      if (next.x >= 0 && next.y >= 0 && next.x < map.cols && next.y < map.rows) queue.push(next);
    }
  }
  return { x: 17, y: 22 };
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

module.exports = { CyberNHSimulation };
