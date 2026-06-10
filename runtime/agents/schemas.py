from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field


class WorkerDecision(BaseModel):
    agent_id: str
    action: Literal[
        "accept_task",
        "continue_task",
        "move_to_room",
        "join_two_person_task",
        "wait_for_second_worker",
        "pause_current_task",
        "return_to_station",
        "reject_all",
        "finish",
    ]
    target_demand_id: Optional[str] = None
    reason: str = Field(description="Short Chinese explanation.")
    confidence: float = Field(ge=0.0, le=1.0)
    memory_update: Dict[str, Any] = Field(default_factory=dict)


class SeniorDecision(BaseModel):
    agent_id: str
    action: Literal[
        "null",
        "call_worker",
        "complaint_broadcast",
        "emergency_broadcast",
        "feedback_after_service",
    ]
    demand_type: Optional[str] = None
    reason: str
    mood_delta: int = Field(ge=-20, le=20, default=0)
    patience_delta: int = Field(ge=-30, le=30, default=0)
    memory_update: Dict[str, Any] = Field(default_factory=dict)


class AssistantDecision(BaseModel):
    agent_id: Literal["Assistant-01"] = "Assistant-01"
    proposal_type: Literal[
        "null",
        "load_warning",
        "emergency_priority",
        "equipment_shortage",
        "coordination_warning",
        "care_mode_suggestion",
    ]
    priority: Literal["null", "low", "medium", "high", "highest"]
    target_demand_ids: List[str] = Field(default_factory=list)
    target_worker_ids: List[str] = Field(default_factory=list)
    reason: str
    broadcast_message: str
    memory_update: Dict[str, Any] = Field(default_factory=dict)

