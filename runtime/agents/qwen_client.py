import json
from typing import Type

from pydantic import BaseModel

from .compact_payload import compact_worker_payload
from .llm_config import load_llm_config


WORKER_ACTIONS = [
    "accept_task",
    "join_two_person_task",
    "reject_all",
    "return_to_station",
    "continue_task",
    "pause_current_task",
    "finish",
]
SENIOR_ACTIONS = [
    "null",
    "call_worker",
    "complaint_broadcast",
    "emergency_broadcast",
    "feedback_after_service",
]
ASSISTANT_PROPOSALS = [
    "null",
    "load_warning",
    "emergency_priority",
    "equipment_shortage",
    "coordination_warning",
    "care_mode_suggestion",
]
ASSISTANT_PRIORITIES = ["null", "low", "medium", "high", "highest"]


class QwenOpenAICompatibleClient:
    def __init__(self, decision_mode: str | None = None, provider: str | None = None):
        from openai import OpenAI

        cfg = load_llm_config(decision_mode=decision_mode, provider=provider)
        self.cfg = cfg
        self.client = OpenAI(
            base_url=cfg.base_url,
            api_key=cfg.api_key,
            timeout=cfg.timeout_seconds,
        )

    def complete_json(self, system_prompt: str, observation: dict, schema: Type[BaseModel]) -> BaseModel:
        if not self.cfg.api_key:
            raise RuntimeError(f"{self.cfg.api_key_env} is required for {self.cfg.provider_label} mode")

        messages = [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": json.dumps(_runtime_payload(observation), ensure_ascii=False, separators=(",", ":")),
            },
        ]
        kwargs = {
            "model": self.cfg.model,
            "messages": messages,
            "temperature": self.cfg.temperature,
        }
        extra_body = {}
        if self.cfg.request_max_tokens_key == "max_tokens":
            kwargs["max_tokens"] = self.cfg.max_tokens
        else:
            extra_body[self.cfg.request_max_tokens_key] = self.cfg.max_tokens
        if self.cfg.json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        if self.cfg.provider == "deepseek" and self.cfg.thinking and self.cfg.thinking != "default":
            kwargs["thinking"] = {"type": self.cfg.thinking}
        if self.cfg.chat_template_kwargs:
            extra_body["chat_template_kwargs"] = self.cfg.chat_template_kwargs
        if extra_body:
            kwargs["extra_body"] = extra_body
        completion = self.client.chat.completions.create(**kwargs)
        content = completion.choices[0].message.content or "{}"
        parsed = json.loads(_extract_json_object(_strip_json_fence(content)))
        return _model_validate(schema, parsed)


def _strip_json_fence(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.removeprefix("```json").removeprefix("```").strip()
        stripped = stripped.removesuffix("```").strip()
    return stripped


def _extract_json_object(text: str) -> str:
    source = text.strip()
    if source.startswith("{"):
        return source

    start = source.find("{")
    if start < 0:
        return source

    depth = 0
    in_string = False
    escape = False
    for index, char in enumerate(source[start:], start=start):
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start : index + 1]
    return source


def _model_validate(schema: Type[BaseModel], payload: dict) -> BaseModel:
    if hasattr(schema, "model_validate"):
        return schema.model_validate(payload)
    return schema.parse_obj(payload)


def _runtime_payload(observation: dict) -> dict:
    agent_type = observation.get("agentType")
    if agent_type == "Worker-Agent":
        return compact_worker_payload(observation)
    elif agent_type == "Senior-Agent":
        output_schema = _senior_decision_schema(observation)
        important = [
            "Use exactly these keys: agent_id, action, demand_type, reason, mood_delta, patience_delta, memory_update.",
            "Do not output markdown or commentary.",
        ]
    elif agent_type == "Assistant-Agent":
        output_schema = _assistant_decision_schema()
        important = [
            "Use exactly these keys: agent_id, proposal_type, priority, target_demand_ids, target_worker_ids, reason, broadcast_message, memory_update.",
            "Do not assign tasks directly. Only recommend or broadcast.",
        ]
    else:
        output_schema = None
        important = ["Return one valid JSON object only."]

    return {
        "instruction": "Return one valid JSON object only. No markdown. No chain-of-thought.",
        "output_schema": output_schema,
        "important": important,
        "observation": observation,
    }


def _worker_decision_schema(observation: dict) -> dict:
    agent_id = observation.get("agentId")
    target_ids = [demand.get("demandId") for demand in observation.get("candidateDemands", []) if demand.get("demandId")]
    return {
        "type": "object",
        "required": ["agent_id", "action", "target_demand_id", "reason", "confidence", "memory_update"],
        "additionalProperties": False,
        "properties": {
            "agent_id": {"const": agent_id},
            "action": {"enum": WORKER_ACTIONS},
            "target_demand_id": {"enum": [*target_ids, None]},
            "reason": {"type": "string"},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "memory_update": {"type": "object"},
        },
        "example": {
            "agent_id": agent_id,
            "action": "accept_task",
            "target_demand_id": "Q001",
            "reason": "距离近且设备可用",
            "confidence": 0.82,
            "memory_update": {},
        },
    }


def _senior_decision_schema(observation: dict) -> dict:
    return {
        "type": "object",
        "required": ["agent_id", "action", "demand_type", "reason", "mood_delta", "patience_delta", "memory_update"],
        "additionalProperties": False,
        "properties": {
            "agent_id": {"const": observation.get("agentId")},
            "action": {"enum": SENIOR_ACTIONS},
            "demand_type": {"type": ["string", "null"]},
            "reason": {"type": "string"},
            "mood_delta": {"type": "number", "minimum": -20, "maximum": 20},
            "patience_delta": {"type": "number", "minimum": -30, "maximum": 30},
            "memory_update": {"type": "object"},
        },
    }


def _assistant_decision_schema() -> dict:
    return {
        "type": "object",
        "required": [
            "agent_id",
            "proposal_type",
            "priority",
            "target_demand_ids",
            "target_worker_ids",
            "reason",
            "broadcast_message",
            "memory_update",
        ],
        "additionalProperties": False,
        "properties": {
            "agent_id": {"const": "Assistant-01"},
            "proposal_type": {"enum": ASSISTANT_PROPOSALS},
            "priority": {"enum": ASSISTANT_PRIORITIES},
            "target_demand_ids": {"type": "array"},
            "target_worker_ids": {"type": "array"},
            "reason": {"type": "string"},
            "broadcast_message": {"type": "string"},
            "memory_update": {"type": "object"},
        },
    }
