#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT_DIR = Path(__file__).resolve().parents[3]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from runtime.agents.compact_payload import compact_worker_payload

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


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="Evaluate whether CyberNH system-scenario LoRA is loaded and useful.")
    parser.add_argument("--base-url", default=os.getenv("CYBERNH_LLM_BASE_URL", "http://127.0.0.1:8000/v1"))
    parser.add_argument("--api-key", default=os.getenv("CYBERNH_LLM_API_KEY", "EMPTY"))
    parser.add_argument("--model", default=os.getenv("CYBERNH_LLM_MODEL", "qwen3-8b-instruct"))
    parser.add_argument("--eval-file", default=str(root / "data" / "eval.jsonl"))
    parser.add_argument("--expected-adapter", default=default_expected_adapter(root))
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--max-tokens", type=int, default=220)
    return parser.parse_args()


def read_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    with path.open("r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            value = value.strip().strip('"').strip("'")
            values[key.strip()] = value
    return values


def default_expected_adapter(root: Path) -> str:
    if os.getenv("CYBERNH_LLM_ADAPTER_DIR"):
        return os.environ["CYBERNH_LLM_ADAPTER_DIR"]
    project_root = root.parents[2]
    llm_dir = Path(os.getenv("CYBERNH_LLM_DIR", project_root.parent / f"{project_root.name}-LLM"))
    return read_dotenv(llm_dir / ".env").get("CYBERNH_LLM_ADAPTER_DIR", "")


def request_json(method: str, url: str, api_key: str, payload: dict[str, Any] | None = None, timeout: float = 30.0) -> dict[str, Any]:
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Authorization": f"Bearer {api_key}"}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    request = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {url} failed: HTTP {exc.code}: {body}") from exc
    except URLError as exc:
        raise RuntimeError(f"{method} {url} failed: {exc.reason}") from exc


def extract_json_object(text: str) -> dict[str, Any]:
    source = str(text or "").strip()
    if source.startswith("```"):
        source = re.sub(r"^```(?:json)?", "", source, flags=re.IGNORECASE).strip()
        source = re.sub(r"```$", "", source).strip()
    if source.startswith("{"):
        return json.loads(source)

    start = source.find("{")
    if start < 0:
        raise ValueError("no JSON object found")
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
                return json.loads(source[start : index + 1])
    raise ValueError("unterminated JSON object")


def load_records(path: Path) -> list[dict[str, Any]]:
    records = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                records.append(json.loads(line))
    return records


def worker_schema(observation: dict[str, Any]) -> dict[str, Any]:
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
            "confidence": {"type": "number"},
            "memory_update": {"type": "object"},
        },
    }


def senior_schema(observation: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "required": ["agent_id", "action", "demand_type", "reason", "mood_delta", "patience_delta", "memory_update"],
        "additionalProperties": False,
        "properties": {
            "agent_id": {"const": observation.get("agentId")},
            "action": {"enum": SENIOR_ACTIONS},
            "demand_type": {"type": ["string", "null"]},
            "reason": {"type": "string"},
            "mood_delta": {"type": "number"},
            "patience_delta": {"type": "number"},
            "memory_update": {"type": "object"},
        },
    }


def assistant_schema() -> dict[str, Any]:
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


def user_payload(record: dict[str, Any]) -> dict[str, Any]:
    original = json.loads(record["messages"][1]["content"])
    observation = original.get("observation", {})
    agent_type = record["agent_type"]
    if agent_type == "Worker-Agent":
        return compact_worker_payload(observation)
    elif agent_type == "Senior-Agent":
        schema = senior_schema(observation)
        important = [
            "Use exactly these keys: agent_id, action, demand_type, reason, mood_delta, patience_delta, memory_update.",
            "Do not output markdown or commentary.",
        ]
    else:
        schema = assistant_schema()
        important = [
            "Use exactly these keys: agent_id, proposal_type, priority, target_demand_ids, target_worker_ids, reason, broadcast_message, memory_update.",
            "Do not assign tasks directly. Only recommend or broadcast.",
        ]
    return {
        "instruction": "Return one valid JSON object only. No markdown. No chain-of-thought.",
        "output_schema": schema,
        "important": important,
        "observation": observation,
    }


def evaluate_record(record: dict[str, Any], prediction: dict[str, Any]) -> list[str]:
    expected = json.loads(record["messages"][2]["content"])
    errors: list[str] = []
    agent_type = record["agent_type"]

    if agent_type == "Worker-Agent":
        expected_agent = expected["agent_id"]
        allowed_ids = {demand.get("demandId") for demand in json.loads(record["messages"][1]["content"])["observation"].get("candidateDemands", [])}
        if prediction.get("agent_id") != expected_agent:
            errors.append(f"agent_id expected {expected_agent}, got {prediction.get('agent_id')}")
        if prediction.get("action") not in WORKER_ACTIONS:
            errors.append(f"unsupported worker action {prediction.get('action')}")
        if prediction.get("action") != expected["action"]:
            errors.append(f"action expected {expected['action']}, got {prediction.get('action')}")
        if expected.get("target_demand_id") != prediction.get("target_demand_id"):
            errors.append(f"target expected {expected.get('target_demand_id')}, got {prediction.get('target_demand_id')}")
        if prediction.get("target_demand_id") and prediction.get("target_demand_id") not in allowed_ids:
            errors.append(f"target {prediction.get('target_demand_id')} is outside candidateDemands")
    elif agent_type == "Senior-Agent":
        if prediction.get("agent_id") != expected["agent_id"]:
            errors.append(f"agent_id expected {expected['agent_id']}, got {prediction.get('agent_id')}")
        if prediction.get("action") not in SENIOR_ACTIONS:
            errors.append(f"unsupported senior action {prediction.get('action')}")
        if prediction.get("action") != expected["action"]:
            errors.append(f"action expected {expected['action']}, got {prediction.get('action')}")
    else:
        if prediction.get("agent_id") != "Assistant-01":
            errors.append(f"agent_id expected Assistant-01, got {prediction.get('agent_id')}")
        if prediction.get("proposal_type") not in ASSISTANT_PROPOSALS:
            errors.append(f"unsupported proposal_type {prediction.get('proposal_type')}")
        if prediction.get("priority") not in ASSISTANT_PRIORITIES:
            errors.append(f"unsupported priority {prediction.get('priority')}")
        if prediction.get("proposal_type") != expected["proposal_type"]:
            errors.append(f"proposal expected {expected['proposal_type']}, got {prediction.get('proposal_type')}")
        expected_targets = set(expected.get("target_demand_ids", []))
        predicted_targets = set(prediction.get("target_demand_ids", []) or [])
        if expected_targets and not expected_targets.issubset(predicted_targets):
            errors.append(f"targets expected to include {sorted(expected_targets)}, got {sorted(predicted_targets)}")

    return errors


def completion(base_url: str, api_key: str, model: str, record: dict[str, Any], timeout: float, max_tokens: int) -> dict[str, Any]:
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": record["scenario"]},
            {"role": "user", "content": json.dumps(user_payload(record), ensure_ascii=False, separators=(",", ":"))},
        ],
        "temperature": 0,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
    }
    result = request_json("POST", f"{base_url.rstrip('/')}/chat/completions", api_key, payload, timeout)
    content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
    return extract_json_object(content)


def main() -> int:
    args = parse_args()
    base_url = args.base_url.rstrip("/")
    print(f"base_url={base_url}")
    health = request_json("GET", f"{base_url}/health", args.api_key, timeout=args.timeout)
    print("health=" + json.dumps(health, ensure_ascii=False))
    expected_adapter = args.expected_adapter.strip()
    if expected_adapter and health.get("adapter") != expected_adapter:
        print(f"FAIL adapter expected {expected_adapter}, got {health.get('adapter')}", file=sys.stderr)
        return 2
    if expected_adapter:
        print(f"adapter_check=PASS expected_adapter={expected_adapter}")
    elif health.get("adapter"):
        print(f"adapter_check=INFO loaded_adapter={health.get('adapter')}")
    else:
        print("adapter_check=WARN no adapter reported by /v1/health")

    records = load_records(Path(args.eval_file))
    failures = 0
    start = time.time()
    for record in records:
        try:
            prediction = completion(base_url, args.api_key, args.model, record, args.timeout, args.max_tokens)
            errors = evaluate_record(record, prediction)
        except Exception as exc:
            prediction = None
            errors = [str(exc)]
        status = "PASS" if not errors else "FAIL"
        print(f"{status} {record['id']} {record['scenario']} {record['agent_type']}")
        if prediction is not None:
            print("  prediction=" + json.dumps(prediction, ensure_ascii=False))
        for error in errors:
            print(f"  error={error}")
        if errors:
            failures += 1
    elapsed = time.time() - start
    passed = len(records) - failures
    print(f"summary: passed={passed} failed={failures} total={len(records)} elapsed={elapsed:.1f}s")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
