# Rules Adapter Evaluation

Adapter:

```text
/Users/chongzhang/CyberNH-LLM/adapters/rules-lora
```

Live endpoint check:

```text
health_ok=True
model=qwen3-vl-2b-instruct
adapter=/Users/chongzhang/CyberNH-LLM/adapters/rules-lora
adapter_check=PASS
```

## Sparse Probe

Prompt shape: only `case_id`, `rule_ids`, and `input`; no full rule text or output schema.

Result:

```text
rules_eval_passed=0/7
```

Observed failure pattern:

- The model usually emitted valid JSON.
- It often reduced `expected` to a boolean instead of the required nested object.
- This means the adapter is loaded, but sparse zero-shot rule recall is not reliable enough for structured runtime use.

## Trained-Format Probe

Prompt shape: `runtime/fine_tuning/rules/data/eval_rules.jsonl` user payload, including relevant rule summaries.

Result:

```text
rules_eval_passed=3/7
```

Passed:

- `EVAL-CNH-004`
- `EVAL-CNH-005`
- `EVAL-CNH-006`

Failed:

- `EVAL-CNH-001`: preserved preemption semantics, but missed exact keys `allowed_interrupted_task_outcomes` and `must_preserve_remaining_time_if_paused`.
- `EVAL-CNH-002`: recognized two-person coordination reason, but emitted `within_rule_range` instead of `service_can_start=false/state=coordination_waiting`.
- `EVAL-CNH-003`: same key-instability pattern for two-person coordination.
- `EVAL-CNH-007`: computed `0.84`, but emitted it as `expected_metric/expected_value` instead of `task_completion_rate`.

## Conclusion

The rules LoRA was successfully trained and loaded, but current behavior is only partially effective:

- Effective for adapter loading and some rule families.
- Not yet reliable for strict structured JSON keys.
- Needs additional structure-stabilization examples or stronger runtime output schema in the prompt before using it as a dependable rules decision adapter.
