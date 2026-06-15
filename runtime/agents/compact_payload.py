from __future__ import annotations

from typing import Any


WORKER_DECISION_SCHEMA = "WorkerDecisionV1"
WORKER_DEMAND_FIELDS = [
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
]


def compact_worker_payload(observation: dict[str, Any]) -> dict[str, Any]:
    memory = observation.get("workerMemory") or {}
    public = memory.get("publicMemory") or {}
    queue = memory.get("taskQueue") or {}
    env = memory.get("envMemory") or {}
    exp = memory.get("expMemory") or {}
    panel = observation.get("panelState") or {}
    current_task = observation.get("currentTask") or {}
    status = public.get("status", observation.get("status"))
    fatigue = public.get("fatigue", observation.get("fatigue"))

    state = _drop_empty(
        {
            "wing": public.get("wing"),
            "tile": _tile(public.get("currentTile")),
            "status": status,
            "fatigue": fatigue,
            "speed": public.get("effectiveSpeedMPerMin"),
            "current": public.get("currentTaskId") or current_task.get("demandId"),
            "current_cls": current_task.get("taskClass"),
            "current_remaining": current_task.get("remainingServiceTicks"),
            "done_count": public.get("completedTaskCount") or _count(queue.get("done")),
            "walk_m": public.get("totalWalkingDistanceM"),
            "service_ticks": public.get("totalServiceTicks"),
            "queue": _drop_empty(
                {
                    "todo": queue.get("todo"),
                    "doing": queue.get("doing"),
                    "done_count": _count(queue.get("done")),
                    "paused_count": _count(queue.get("paused")),
                    "abandoned_count": _count(queue.get("abandoned")),
                }
            ),
        }
    )

    return _drop_empty(
        {
            "schema": WORKER_DECISION_SCHEMA,
            "aid": observation.get("agentId"),
            "tick": observation.get("tick"),
            "time": observation.get("currentTime"),
            "mode": observation.get("careMode"),
            "sim": _drop_empty(
                {
                    "duration": panel.get("durationTicks"),
                    "days": panel.get("simulationDays"),
                    "total": panel.get("totalDurationTicks"),
                }
            ),
            "state": state,
            "constraints": _compact_constraints(observation.get("constraints") or {}, status, fatigue),
            "eq": env.get("knownEquipment"),
            "congestion": env.get("congestedAreas"),
            "nearby": env.get("nearbyPendingDemands"),
            "stable_seniors": exp.get("stableSeniorIds"),
            "prefs": exp.get("learnedPreferenceTags"),
            "recent_reasons": exp.get("recentDecisionReasons"),
            "demand_fields": WORKER_DEMAND_FIELDS,
            "demands": [_compact_demand(demand) for demand in observation.get("candidateDemands", [])],
            "allowed_targets": _allowed_targets(observation),
        }
    )


def _compact_constraints(constraints: dict[str, Any], status: Any = None, fatigue: Any = None) -> dict[str, Any]:
    unavailable = constraints.get("unavailable")
    if unavailable is None and status is not None:
        unavailable = status == "unavailable"
    accept = constraints.get("canAcceptNewTask")
    if accept is None and status is not None:
        accept = status == "idle" and not unavailable
    return _drop_empty(
        {
            "accept": accept,
            "preempt": constraints.get("canPreemptCurrentTask"),
            "fatigue_warn": constraints.get("fatigueWarning"),
            "unavailable": unavailable,
        }
    )


def _compact_demand(demand: dict[str, Any]) -> list[Any]:
    return [
        demand.get("demandId"),
        demand.get("room"),
        demand.get("taskLabelZh"),
        demand.get("taskClass"),
        demand.get("status"),
        demand.get("seniorCareLevel"),
        demand.get("priorityLevel"),
        demand.get("priorityScore"),
        demand.get("waitingTicks"),
        demand.get("requiredWorkers"),
        demand.get("assignedWorkerIds") or [],
        demand.get("arrivedWorkerIds") or [],
        demand.get("requiredEquipment") or [],
        demand.get("equipmentAvailable"),
        demand.get("routeDistanceM", demand.get("distanceM")),
        demand.get("estimatedArrivalTicks"),
        demand.get("stableRelation"),
    ]


def _allowed_targets(observation: dict[str, Any]) -> list[Any]:
    targets = [demand.get("demandId") for demand in observation.get("candidateDemands", []) if demand.get("demandId")]
    return [*targets, None]


def _tile(value: Any) -> Any:
    if isinstance(value, dict) and "x" in value and "y" in value:
        return [value.get("x"), value.get("y")]
    return value


def _count(value: Any) -> int:
    return len(value) if isinstance(value, list) else 0


def _drop_empty(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in payload.items()
        if value is not None and value != [] and value != {}
    }
