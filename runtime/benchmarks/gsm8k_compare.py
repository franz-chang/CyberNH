#!/usr/bin/env python3
"""Run timed GSM8K prompts against an OpenAI-compatible chat endpoint."""

from __future__ import annotations

import argparse
import csv
import json
import random
import re
import statistics
import time
import urllib.error
import urllib.request
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any


GSM8K_TEST_URL = (
    "https://raw.githubusercontent.com/openai/grade-school-math/"
    "master/grade_school_math/data/test.jsonl"
)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                items.append(json.loads(line))
    return items


def write_jsonl(path: Path, items: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for item in items:
            handle.write(json.dumps(item, ensure_ascii=False) + "\n")


def download_gsm8k(cache_path: Path) -> list[dict[str, Any]]:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    if not cache_path.exists():
        print(f"Downloading GSM8K test split: {GSM8K_TEST_URL}")
        urllib.request.urlretrieve(GSM8K_TEST_URL, cache_path)
    return read_jsonl(cache_path)


def load_or_create_sample(
    sample_path: Path,
    dataset: list[dict[str, Any]],
    sample_size: int,
    seed: int,
) -> list[dict[str, Any]]:
    if sample_path.exists():
        return read_jsonl(sample_path)
    rng = random.Random(seed)
    indexes = rng.sample(range(len(dataset)), sample_size)
    sample = [
        {
            "sample_id": index + 1,
            "dataset_index": dataset_index,
            "question": dataset[dataset_index]["question"],
            "answer": dataset[dataset_index]["answer"],
        }
        for index, dataset_index in enumerate(indexes)
    ]
    write_jsonl(sample_path, sample)
    return sample


def post_chat_completion(
    base_url: str,
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
    max_tokens: int,
    temperature: float,
    timeout_seconds: float,
) -> dict[str, Any]:
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
        return json.loads(response.read().decode("utf-8"))


def expected_final(answer: str) -> str:
    if "####" in answer:
        return answer.rsplit("####", 1)[1].strip()
    numbers = re.findall(r"-?\d+(?:,\d{3})*(?:\.\d+)?", answer)
    return numbers[-1] if numbers else ""


def model_final(answer: str) -> str:
    if "####" in answer:
        tail = answer.rsplit("####", 1)[1]
        numbers = re.findall(r"-?\d+(?:,\d{3})*(?:\.\d+)?", tail)
        if numbers:
            return numbers[-1]
    numbers = re.findall(r"-?\d+(?:,\d{3})*(?:\.\d+)?", answer)
    return numbers[-1] if numbers else ""


def normalize_number(value: str) -> Decimal | None:
    cleaned = value.replace(",", "").replace("$", "").strip()
    try:
        return Decimal(cleaned)
    except (InvalidOperation, ValueError):
        return None


def is_correct(predicted: str, expected: str) -> bool:
    predicted_number = normalize_number(predicted)
    expected_number = normalize_number(expected)
    return predicted_number is not None and predicted_number == expected_number


def append_summary(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "model_label",
        "model",
        "sample_size",
        "seed",
        "total_seconds",
        "avg_seconds",
        "median_seconds",
        "min_seconds",
        "max_seconds",
        "correct",
        "accuracy",
    ]
    exists = path.exists()
    with path.open("a", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        if not exists:
            writer.writeheader()
        writer.writerow({key: row.get(key, "") for key in fieldnames})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-label", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--base-url", default="http://localhost:8000/v1")
    parser.add_argument("--api-key", default="EMPTY")
    parser.add_argument("--dataset-cache", required=True)
    parser.add_argument("--sample-file", required=True)
    parser.add_argument("--results-jsonl", required=True)
    parser.add_argument("--summary-csv", required=True)
    parser.add_argument("--sample-size", type=int, default=10)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--max-tokens", type=int, default=256)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--timeout-seconds", type=float, default=300.0)
    args = parser.parse_args()

    dataset = download_gsm8k(Path(args.dataset_cache))
    sample = load_or_create_sample(Path(args.sample_file), dataset, args.sample_size, args.seed)

    results_path = Path(args.results_jsonl)
    results_path.parent.mkdir(parents=True, exist_ok=True)

    system_prompt = (
        "You solve GSM8K grade-school math problems. "
        "Reason briefly and end with the final answer formatted exactly as '#### number'."
    )

    elapsed_values: list[float] = []
    correct_count = 0
    total_started_at = time.perf_counter()

    with results_path.open("a", encoding="utf-8") as results_handle:
        for index, item in enumerate(sample, start=1):
            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": item["question"]},
            ]
            started_at = time.perf_counter()
            error = None
            response: dict[str, Any] | None = None
            content = ""
            try:
                response = post_chat_completion(
                    base_url=args.base_url,
                    api_key=args.api_key,
                    model=args.model,
                    messages=messages,
                    max_tokens=args.max_tokens,
                    temperature=args.temperature,
                    timeout_seconds=args.timeout_seconds,
                )
                content = str(response["choices"][0]["message"]["content"])
            except (urllib.error.URLError, TimeoutError, KeyError, json.JSONDecodeError) as exc:
                error = str(exc)
            elapsed = time.perf_counter() - started_at
            elapsed_values.append(elapsed)

            expected = expected_final(str(item["answer"]))
            predicted = model_final(content)
            correct = is_correct(predicted, expected)
            if correct:
                correct_count += 1

            usage = response.get("usage", {}) if response else {}
            record = {
                "model_label": args.model_label,
                "model": args.model,
                "sample_id": item["sample_id"],
                "dataset_index": item["dataset_index"],
                "elapsed_seconds": round(elapsed, 4),
                "question": item["question"],
                "expected_final": expected,
                "model_final": predicted,
                "correct": correct,
                "prompt_tokens": usage.get("prompt_tokens"),
                "completion_tokens": usage.get("completion_tokens"),
                "total_tokens": usage.get("total_tokens"),
                "response": content,
                "error": error,
            }
            results_handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            results_handle.flush()

            status = "ok" if error is None else "error"
            print(
                f"[{args.model_label}] {index}/{len(sample)} "
                f"{elapsed:.2f}s correct={correct} status={status}"
            )

    total_seconds = time.perf_counter() - total_started_at
    summary = {
        "model_label": args.model_label,
        "model": args.model,
        "sample_size": len(sample),
        "seed": args.seed,
        "total_seconds": round(total_seconds, 4),
        "avg_seconds": round(statistics.fmean(elapsed_values), 4),
        "median_seconds": round(statistics.median(elapsed_values), 4),
        "min_seconds": round(min(elapsed_values), 4),
        "max_seconds": round(max(elapsed_values), 4),
        "correct": correct_count,
        "accuracy": round(correct_count / len(sample), 4) if sample else 0,
    }
    append_summary(Path(args.summary_csv), summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
