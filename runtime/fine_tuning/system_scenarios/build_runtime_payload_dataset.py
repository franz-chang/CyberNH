#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from evaluate_adapter import user_payload


BOUNDARY_RECORDS = [
    {
        "id": "senior_boundary_waiting_below_threshold_null",
        "scenario": "[System Scenario 2]",
        "agent_type": "Senior-Agent",
        "messages": [
            {"role": "system", "content": "[System Scenario 2]"},
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "instruction": "Return one SeniorDecision JSON object only.",
                        "observation": {
                            "agentType": "Senior-Agent",
                            "agentId": "Senior-B01",
                            "health": 64,
                            "mood": 52,
                            "patience": 46,
                            "waiting_ticks": 6,
                            "escalation_threshold": 10,
                            "current_status": "waiting",
                            "activeDemand": {"demandId": "QB101", "taskLabelZh": "取物"},
                        },
                    },
                    ensure_ascii=False,
                ),
            },
            {
                "role": "assistant",
                "content": '{"agent_id":"Senior-B01","action":"null","demand_type":null,"reason":"仍在等待但未超过升级阈值，暂不广播抱怨","mood_delta":-1,"patience_delta":-2,"memory_update":{}}',
            },
        ],
    },
    {
        "id": "senior_boundary_waiting_at_threshold_complaint",
        "scenario": "[System Scenario 2]",
        "agent_type": "Senior-Agent",
        "messages": [
            {"role": "system", "content": "[System Scenario 2]"},
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "instruction": "Return one SeniorDecision JSON object only.",
                        "observation": {
                            "agentType": "Senior-Agent",
                            "agentId": "Senior-B02",
                            "health": 61,
                            "mood": 40,
                            "patience": 20,
                            "waiting_ticks": 11,
                            "escalation_threshold": 10,
                            "current_status": "waiting",
                            "activeDemand": {"demandId": "QB102", "taskLabelZh": "如厕协助"},
                        },
                    },
                    ensure_ascii=False,
                ),
            },
            {
                "role": "assistant",
                "content": '{"agent_id":"Senior-B02","action":"complaint_broadcast","demand_type":"如厕协助","reason":"等待已超过升级阈值且耐心较低，应发出抱怨广播","mood_delta":-3,"patience_delta":-6,"memory_update":{"complained_about":"QB102"}}',
            },
        ],
    },
    {
        "id": "assistant_boundary_health_risk_priority",
        "scenario": "[System Scenario 3]",
        "agent_type": "Assistant-Agent",
        "messages": [
            {"role": "system", "content": "[System Scenario 3]"},
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "instruction": "Return one AssistantDecision JSON object only.",
                        "observation": {
                            "agentType": "Assistant-Agent",
                            "seniorDemandRow": [
                                {"demandId": "QB201", "status": "waiting", "care_level": 3, "health": 32}
                            ],
                            "workerResourceRow": [{"workerId": "Worker-B01", "status": "idle"}],
                            "metrics": {"systemLoad": "normal"},
                        },
                    },
                    ensure_ascii=False,
                ),
            },
            {
                "role": "assistant",
                "content": '{"agent_id":"Assistant-01","proposal_type":"emergency_priority","priority":"highest","target_demand_ids":["QB201"],"target_worker_ids":[],"reason":"高照护等级老人健康值低于35且仍在等待","broadcast_message":"高风险老人正在等待，请优先响应QB201","memory_update":{"health_risk":"QB201"}}',
            },
        ],
    },
    {
        "id": "assistant_boundary_overloaded_care_mode",
        "scenario": "[System Scenario 3]",
        "agent_type": "Assistant-Agent",
        "messages": [
            {"role": "system", "content": "[System Scenario 3]"},
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "instruction": "Return one AssistantDecision JSON object only.",
                        "observation": {
                            "agentType": "Assistant-Agent",
                            "seniorDemandRow": [{"demandId": "QB202", "status": "waiting"}],
                            "workerResourceRow": [],
                            "metrics": {"systemLoad": "overloaded", "overloadedTicks": 22, "timeoutRate": 0.28},
                        },
                    },
                    ensure_ascii=False,
                ),
            },
            {
                "role": "assistant",
                "content": '{"agent_id":"Assistant-01","proposal_type":"care_mode_suggestion","priority":"medium","target_demand_ids":[],"target_worker_ids":[],"reason":"系统长期过载，可建议临时采用更实用的照护策略但不能强制切换","broadcast_message":"系统持续过载，建议管理端考虑临时调整照护策略","memory_update":{"suggested_due_to_overload":true}}',
            },
        ],
    },
    {
        "id": "assistant_boundary_load_warning_not_care_mode",
        "scenario": "[System Scenario 3]",
        "agent_type": "Assistant-Agent",
        "messages": [
            {"role": "system", "content": "[System Scenario 3]"},
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "instruction": "Return one AssistantDecision JSON object only.",
                        "observation": {
                            "agentType": "Assistant-Agent",
                            "seniorDemandRow": [{"demandId": f"QB30{i}"} for i in range(1, 10)],
                            "workerResourceRow": [],
                            "metrics": {"pendingDemandCount": 9, "idleWorkerCount": 0, "systemLoad": "high"},
                        },
                    },
                    ensure_ascii=False,
                ),
            },
            {
                "role": "assistant",
                "content": '{"agent_id":"Assistant-01","proposal_type":"load_warning","priority":"high","target_demand_ids":[],"target_worker_ids":[],"reason":"等待需求较多且没有空闲护工，应发出负荷警告","broadcast_message":"当前无空闲护工，请关注等待超时风险","memory_update":{"last_load_warning":"high"}}',
            },
        ],
    },
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build runtime-shaped SFT JSONL from CyberNH scenario records.")
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--include-boundary-cases", action="store_true", help="Append curated contrastive boundary records.")
    parser.add_argument("--include-regression-anchors", type=Path, help="Append runtime-shaped records from the behavior regression file.")
    parser.add_argument("--repeat", type=int, default=1, help="Repeat every emitted record this many times.")
    return parser.parse_args()


def to_runtime_record(record: dict) -> dict:
    runtime_record = dict(record)
    runtime_record["id"] = f"{record['id']}_runtime_payload"
    runtime_record["messages"] = [
        record["messages"][0],
        {
            "role": "user",
            "content": json.dumps(user_payload(record), ensure_ascii=False),
        },
        record["messages"][2],
    ]
    return runtime_record


def read_records(path: Path) -> list[dict]:
    records = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                records.append(json.loads(line))
    return records


def main() -> int:
    args = parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    records = read_records(args.input)
    if args.include_boundary_cases:
        records.extend(BOUNDARY_RECORDS)
    if args.include_regression_anchors:
        records.extend(read_records(args.include_regression_anchors))

    count = 0
    repeat = max(1, args.repeat)
    with args.output.open("w", encoding="utf-8") as dst:
        for record in records:
            runtime_record = to_runtime_record(record)
            for copy_index in range(repeat):
                emitted = dict(runtime_record)
                if repeat > 1:
                    emitted["id"] = f"{runtime_record['id']}_repeat_{copy_index + 1}"
                dst.write(json.dumps(emitted, ensure_ascii=False, separators=(",", ":")) + "\n")
                count += 1
    print(f"wrote {count} records to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
