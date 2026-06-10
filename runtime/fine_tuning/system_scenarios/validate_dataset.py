#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


SCENARIOS = {
    "[System Scenario 1]": "Worker-Agent",
    "[System Scenario 2]": "Senior-Agent",
    "[System Scenario 3]": "Assistant-Agent",
}
REQUIRED_ROLES = ["system", "user", "assistant"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate CyberNH system-scenario SFT JSONL files.")
    parser.add_argument("files", nargs="+", type=Path)
    return parser.parse_args()


def validate_record(record: dict, path: Path, line_number: int) -> None:
    prefix = f"{path}:{line_number}"
    for key in ("id", "scenario", "agent_type", "messages"):
        if key not in record:
            raise ValueError(f"{prefix}: missing key {key}")

    scenario = record["scenario"]
    if scenario not in SCENARIOS:
        raise ValueError(f"{prefix}: unsupported scenario {scenario!r}")
    if record["agent_type"] != SCENARIOS[scenario]:
        raise ValueError(f"{prefix}: agent_type does not match scenario")

    messages = record["messages"]
    if not isinstance(messages, list) or len(messages) != 3:
        raise ValueError(f"{prefix}: messages must contain exactly system/user/assistant")

    for index, role in enumerate(REQUIRED_ROLES):
        message = messages[index]
        if not isinstance(message, dict):
            raise ValueError(f"{prefix}: message {index} is not an object")
        if message.get("role") != role:
            raise ValueError(f"{prefix}: message {index} role must be {role}")
        if not isinstance(message.get("content"), str) or not message["content"].strip():
            raise ValueError(f"{prefix}: message {index} content must be non-empty string")

    if messages[0]["content"] != scenario:
        raise ValueError(f"{prefix}: system message must equal scenario tag")

    try:
        json.loads(messages[1]["content"])
    except json.JSONDecodeError as exc:
        raise ValueError(f"{prefix}: user content is not JSON: {exc}") from exc

    try:
        assistant = json.loads(messages[2]["content"])
    except json.JSONDecodeError as exc:
        raise ValueError(f"{prefix}: assistant content is not JSON: {exc}") from exc

    if record["agent_type"] == "Worker-Agent":
        required = {"agent_id", "action", "target_demand_id", "reason", "confidence", "memory_update"}
    elif record["agent_type"] == "Senior-Agent":
        required = {"agent_id", "action", "demand_type", "reason", "mood_delta", "patience_delta", "memory_update"}
    else:
        required = {
            "agent_id",
            "proposal_type",
            "priority",
            "target_demand_ids",
            "target_worker_ids",
            "reason",
            "broadcast_message",
            "memory_update",
        }
    missing = required - set(assistant)
    if missing:
        raise ValueError(f"{prefix}: assistant JSON missing keys {sorted(missing)}")


def validate_file(path: Path) -> int:
    count = 0
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            record = json.loads(line)
            validate_record(record, path, line_number)
            count += 1
    return count


def main() -> int:
    args = parse_args()
    total = 0
    for path in args.files:
        count = validate_file(path)
        print(f"{path}: {count} records OK")
        total += count
    print(f"total: {total} records OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
