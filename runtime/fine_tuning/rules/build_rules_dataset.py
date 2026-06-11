#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


ROOT_DIR = Path(__file__).resolve().parents[3]
RULES_DIR = ROOT_DIR / "rules"
SYSTEM_ANCHOR_FILE = ROOT_DIR / "runtime" / "fine_tuning" / "system_scenarios" / "data" / "train_augmented_runtime.jsonl"
RULE_SYSTEM_PROMPT = (
    "You are a Cyber-NH rules and priority reasoning adapter. Return one valid JSON object only. "
    "Apply the provided nursing-home rules when judging patient/resident priority, task preemption, "
    "two-person coordination, acuity-driven demand probability, hidden workload, and metrics."
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build CyberNH rules LoRA SFT data from rules/.")
    parser.add_argument("--rules-dir", type=Path, default=RULES_DIR)
    parser.add_argument("--train-output", type=Path, required=True)
    parser.add_argument("--eval-output", type=Path, required=True)
    parser.add_argument("--repeat", type=int, default=2)
    parser.add_argument("--include-system-anchors", action="store_true")
    parser.add_argument("--system-anchor-file", type=Path, default=SYSTEM_ANCHOR_FILE)
    return parser.parse_args()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    if not path.exists():
        return records
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                records.append(json.loads(line))
    return records


def write_jsonl(path: Path, records: list[dict[str, Any]], repeat: int = 1) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            for index in range(max(1, repeat)):
                emitted = dict(record)
                if repeat > 1:
                    emitted["id"] = f"{record['id']}_repeat_{index + 1}"
                handle.write(json.dumps(emitted, ensure_ascii=False, separators=(",", ":")) + "\n")
                count += 1
    return count


def seed_record(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": record.get("example_id", record.get("id", "rules_seed")),
        "source": "rules/datasets/train_seed.jsonl",
        "rule_ids": record.get("rule_ids", []),
        "messages": record["messages"],
    }


def eval_case_record(case: dict[str, Any], rule_map: dict[str, dict[str, Any]]) -> dict[str, Any]:
    rule_ids = case.get("rule_ids", [])
    relevant_rules = [summarize_rule(rule_map[rule_id]) for rule_id in rule_ids if rule_id in rule_map]
    payload = {
        "instruction": "Apply Cyber-NH rules to this priority or state-evaluation case. Return the expected JSON outcome only.",
        "case_id": case["case_id"],
        "rule_ids": rule_ids,
        "input": case.get("input", {}),
        "relevant_rules": relevant_rules,
    }
    answer = {
        "case_id": case["case_id"],
        "rule_ids": rule_ids,
        "expected": case.get("expected", {}),
        "reason": reason_from_rules(relevant_rules),
    }
    return {
        "id": f"{case['case_id']}_rules_eval_case",
        "source": "rules/datasets/eval_cases.jsonl",
        "rule_ids": rule_ids,
        "messages": [
            {"role": "system", "content": RULE_SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            {"role": "assistant", "content": json.dumps(answer, ensure_ascii=False, separators=(",", ":"))},
        ],
    }


def rule_record(rule: dict[str, Any]) -> dict[str, Any]:
    rule_id = rule["rule_id"]
    payload = {
        "instruction": "Convert this Cyber-NH rule into machine-readable decision guidance for runtime agents.",
        "rule": summarize_rule(rule),
    }
    answer = {
        "rule_id": rule_id,
        "category": rule.get("category"),
        "actor": rule.get("actor"),
        "trigger": rule.get("trigger"),
        "condition": rule.get("condition"),
        "action": rule.get("action"),
        "constraints": rule.get("constraints", []),
        "parameters": rule.get("parameters", {}),
        "priority": rule.get("priority"),
        "enforcement": rule.get("enforcement"),
        "implementation_hint": rule.get("implementation_hint"),
    }
    return {
        "id": f"{rule_id}_rule_guidance",
        "source": "rules/structured/rules.jsonl",
        "rule_ids": [rule_id],
        "messages": [
            {"role": "system", "content": RULE_SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            {"role": "assistant", "content": json.dumps(answer, ensure_ascii=False, separators=(",", ":"))},
        ],
    }


def metric_record(metric: dict[str, Any]) -> dict[str, Any]:
    metric_id = metric["metric_id"]
    payload = {
        "instruction": "Convert this Cyber-NH metric definition into machine-readable measurement guidance.",
        "metric": metric,
    }
    answer = {
        "metric_id": metric_id,
        "name": metric.get("name"),
        "category": metric.get("category"),
        "definition": metric.get("definition"),
        "unit": metric.get("unit"),
        "formula": metric.get("formula"),
        "aggregation_level": metric.get("aggregation_level"),
        "event_fields_required": metric.get("event_fields_required", []),
    }
    return {
        "id": f"{metric_id}_metric_guidance",
        "source": "rules/structured/metrics.jsonl",
        "rule_ids": [metric_id],
        "messages": [
            {"role": "system", "content": RULE_SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            {"role": "assistant", "content": json.dumps(answer, ensure_ascii=False, separators=(",", ":"))},
        ],
    }


def summarize_rule(rule: dict[str, Any]) -> dict[str, Any]:
    keys = [
        "rule_id",
        "category",
        "actor",
        "trigger",
        "condition",
        "action",
        "constraints",
        "parameters",
        "priority",
        "enforcement",
        "implementation_hint",
    ]
    return {key: rule.get(key) for key in keys if key in rule}


def reason_from_rules(rules: list[dict[str, Any]]) -> str:
    if not rules:
        return "Expected output follows the labeled Cyber-NH evaluation case."
    hard = [rule for rule in rules if rule.get("enforcement") == "hard"]
    selected = hard or rules
    return " ; ".join(str(rule.get("action") or rule.get("implementation_hint") or rule.get("condition")) for rule in selected)


def main() -> int:
    args = parse_args()
    rules_dir = args.rules_dir
    rules = read_jsonl(rules_dir / "structured" / "rules.jsonl")
    metrics = read_jsonl(rules_dir / "structured" / "metrics.jsonl")
    seeds = read_jsonl(rules_dir / "datasets" / "train_seed.jsonl")
    eval_cases = read_jsonl(rules_dir / "datasets" / "eval_cases.jsonl")
    rule_map = {rule["rule_id"]: rule for rule in rules}

    train_records: list[dict[str, Any]] = []
    train_records.extend(seed_record(record) for record in seeds)
    train_records.extend(eval_case_record(case, rule_map) for case in eval_cases)
    train_records.extend(rule_record(rule) for rule in rules)
    train_records.extend(metric_record(metric) for metric in metrics)

    if args.include_system_anchors:
        anchors = read_jsonl(args.system_anchor_file)
        train_records.extend(anchors)
        print(f"system_anchors={len(anchors)} file={args.system_anchor_file}")

    eval_records = [eval_case_record(case, rule_map) for case in eval_cases]
    train_count = write_jsonl(args.train_output, train_records, repeat=args.repeat)
    eval_count = write_jsonl(args.eval_output, eval_records, repeat=1)
    print(f"rules={len(rules)} metrics={len(metrics)} seeds={len(seeds)} eval_cases={len(eval_cases)}")
    print(f"wrote train_records={train_count} to {args.train_output}")
    print(f"wrote eval_records={eval_count} to {args.eval_output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
