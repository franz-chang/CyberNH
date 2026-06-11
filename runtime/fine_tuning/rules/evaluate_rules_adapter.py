#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


RULE_SYSTEM_PROMPT = (
    "You are a Cyber-NH rules and priority reasoning adapter. Return one valid JSON object only. "
    "Use the CyberNH rules learned during fine-tuning when judging resident priority, task preemption, "
    "two-person coordination, acuity-driven demand probability, hidden workload, and metrics."
)


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parent
    default_llm_dir = Path(os.getenv("CYBERNH_LLM_DIR", root.parents[3].parent / f"{root.parents[3].name}-LLM"))
    parser = argparse.ArgumentParser(description="Evaluate CyberNH rules LoRA adapter via live OpenAI-compatible endpoint.")
    parser.add_argument("--base-url", default=os.getenv("CYBERNH_LLM_BASE_URL", "http://127.0.0.1:8000/v1"))
    parser.add_argument("--api-key", default=os.getenv("CYBERNH_LLM_API_KEY", "EMPTY"))
    parser.add_argument("--model", default=os.getenv("CYBERNH_LLM_MODEL", "qwen3-vl-2b-instruct"))
    parser.add_argument("--eval-file", type=Path, default=root.parents[2] / "rules" / "datasets" / "eval_cases.jsonl")
    parser.add_argument("--expected-adapter", default=os.getenv("CYBERNH_LLM_ADAPTER_DIR", str(default_llm_dir / "adapters" / "rules-lora")))
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--max-tokens", type=int, default=420)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--trained-format", action="store_true", help="Use runtime/fine_tuning/rules/data/eval_rules.jsonl messages verbatim.")
    return parser.parse_args()


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


def load_records(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                records.append(json.loads(line))
    return records


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


def build_probe(case: dict[str, Any]) -> dict[str, Any]:
    return {
        "instruction": (
            "Apply the learned CyberNH rules. Return one JSON object with keys: "
            "case_id, rule_ids, expected, reason. Do not include markdown."
        ),
        "case_id": case["case_id"],
        "rule_ids": case.get("rule_ids", []),
        "input": case.get("input", {}),
    }


def complete_case(args: argparse.Namespace, case: dict[str, Any]) -> dict[str, Any]:
    if args.trained_format:
        messages = case["messages"][:2]
    else:
        messages = [
            {"role": "system", "content": RULE_SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(build_probe(case), ensure_ascii=False)},
        ]
    payload = {
        "model": args.model,
        "messages": messages,
        "temperature": args.temperature,
        "max_tokens": args.max_tokens,
        "response_format": {"type": "json_object"},
    }
    completion = request_json("POST", f"{args.base_url.rstrip('/')}/chat/completions", args.api_key, payload, args.timeout)
    content = completion.get("choices", [{}])[0].get("message", {}).get("content", "")
    parsed = extract_json_object(content)
    return {
        "raw": content,
        "parsed": parsed,
    }


def compare_expected(expected: Any, actual: Any, path: str = "expected") -> list[str]:
    errors: list[str] = []
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return [f"{path}: expected object, got {type(actual).__name__}"]
        for key, value in expected.items():
            if key not in actual:
                errors.append(f"{path}.{key}: missing")
            else:
                errors.extend(compare_expected(value, actual[key], f"{path}.{key}"))
        return errors
    if isinstance(expected, list):
        if not isinstance(actual, list):
            return [f"{path}: expected list, got {type(actual).__name__}"]
        for item in expected:
            if item not in actual:
                errors.append(f"{path}: missing list item {item!r}")
        return errors
    if isinstance(expected, float):
        try:
            if abs(float(actual) - expected) > 1e-6:
                errors.append(f"{path}: expected {expected!r}, got {actual!r}")
        except (TypeError, ValueError):
            errors.append(f"{path}: expected {expected!r}, got {actual!r}")
        return errors
    if actual != expected:
        errors.append(f"{path}: expected {expected!r}, got {actual!r}")
    return errors


def evaluate_case(case: dict[str, Any], prediction: dict[str, Any]) -> list[str]:
    if "expected" not in case and "messages" in case:
        assistant = json.loads(case["messages"][2]["content"])
        case = {
            "case_id": assistant.get("case_id", case.get("id")),
            "rule_ids": assistant.get("rule_ids", case.get("rule_ids", [])),
            "expected": assistant.get("expected", {}),
        }
    errors: list[str] = []
    if prediction.get("case_id") != case["case_id"]:
        errors.append(f"case_id expected {case['case_id']}, got {prediction.get('case_id')}")
    for rule_id in case.get("rule_ids", []):
        if rule_id not in prediction.get("rule_ids", []):
            errors.append(f"rule_ids missing {rule_id}")
    if "expected" not in prediction:
        errors.append("missing expected object")
    else:
        errors.extend(compare_expected(case.get("expected", {}), prediction["expected"]))
    return errors


def case_label(case: dict[str, Any]) -> str:
    if case.get("case_id"):
        return str(case["case_id"])
    if "messages" in case:
        try:
            assistant = json.loads(case["messages"][2]["content"])
            return str(assistant.get("case_id") or case.get("id"))
        except Exception:
            pass
    return str(case.get("id", "unknown"))


def main() -> int:
    args = parse_args()
    health = request_json("GET", f"{args.base_url.rstrip('/')}/health", args.api_key, timeout=10.0)
    adapter = health.get("adapter")
    adapter_ok = bool(args.expected_adapter) and adapter == args.expected_adapter
    print(f"health_ok={health.get('ok')} model={health.get('model')} adapter={adapter}")
    print(f"expected_adapter={args.expected_adapter}")
    print(f"adapter_check={'PASS' if adapter_ok else 'FAIL'}")

    records = load_records(args.eval_file)
    passed = 0
    failures: list[dict[str, Any]] = []
    for case in records:
        try:
            result = complete_case(args, case)
            prediction = result["parsed"]
            errors = evaluate_case(case, prediction)
        except Exception as exc:
            prediction = None
            errors = [str(exc)]
            result = {"raw": ""}

        if errors:
            label = case_label(case)
            failures.append({"case_id": label, "errors": errors, "raw": result.get("raw"), "prediction": prediction})
            print(f"{label}: FAIL {'; '.join(errors)}")
        else:
            passed += 1
            print(f"{case_label(case)}: PASS")

    total = len(records)
    print(f"rules_eval_passed={passed}/{total}")
    if failures:
        print("failures_json=" + json.dumps(failures, ensure_ascii=False, indent=2))
    return 0 if adapter_ok and passed == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
