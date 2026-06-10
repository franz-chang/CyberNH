import json
from typing import Type

from pydantic import BaseModel

from .llm_config import load_llm_config


class QwenOpenAICompatibleClient:
    def __init__(self):
        from openai import OpenAI

        cfg = load_llm_config()
        self.cfg = cfg
        self.client = OpenAI(
            base_url=cfg.base_url,
            api_key=cfg.api_key,
            timeout=cfg.timeout_seconds,
        )

    def complete_json(self, system_prompt: str, observation: dict, schema: Type[BaseModel]) -> BaseModel:
        messages = [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "instruction": "Return one valid JSON object only. No markdown. No chain-of-thought.",
                        "output_schema": _worker_decision_schema(observation) if observation.get("agentType") == "Worker-Agent" else None,
                        "observation": observation,
                    },
                    ensure_ascii=False,
                ),
            },
        ]
        kwargs = {
            "model": self.cfg.model,
            "messages": messages,
            "temperature": self.cfg.temperature,
            "max_tokens": self.cfg.max_tokens,
        }
        if self.cfg.json_mode:
            kwargs["response_format"] = {"type": "json_object"}
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


def _worker_decision_schema(observation: dict) -> dict:
    agent_id = observation.get("agentId")
    target_ids = [demand.get("demandId") for demand in observation.get("candidateDemands", []) if demand.get("demandId")]
    return {
        "type": "object",
        "required": ["agent_id", "action", "target_demand_id", "reason", "confidence", "memory_update"],
        "additionalProperties": False,
        "properties": {
            "agent_id": {"const": agent_id},
            "action": {
                "enum": [
                    "accept_task",
                    "join_two_person_task",
                    "reject_all",
                    "return_to_station",
                    "continue_task",
                    "pause_current_task",
                    "finish",
                ]
            },
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
