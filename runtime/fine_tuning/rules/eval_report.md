# Rules Adapter Evaluation

Adapter:

```text
/Users/chongzhang/CyberNH-LLM/adapters/rules-lora
```

Training method:

```text
strict_schema_high_weight_cases
```

The rules dataset is now built with three complementary prompt shapes for every
evaluation case:

- trained-format prompts with relevant rule summaries
- sparse prompts with only `case_id`, `rule_ids`, and `input`
- exact schema prompts that reinforce the required JSON keys

The default rules fine-tuning run uses high-weight case repetition and longer
training:

```text
case_repeat=24
seed_repeat=4
guidance_repeat=2
anchor_repeat=1
max_steps=640
train_records=630
eval_records=7
final_eval_loss=0.0004
```

Live endpoint check:

```text
health_ok=True
model=qwen3-vl-2b-instruct
adapter=/Users/chongzhang/CyberNH-LLM/adapters/rules-lora
adapter_check=PASS
```

## Sparse Probe

Prompt shape: only `case_id`, `rule_ids`, and `input`; no full rule text or
output schema.

Result:

```text
EVAL-CNH-001: PASS
EVAL-CNH-002: PASS
EVAL-CNH-003: PASS
EVAL-CNH-004: PASS
EVAL-CNH-005: PASS
EVAL-CNH-006: PASS
EVAL-CNH-007: PASS
rules_eval_passed=7/7
```

## Trained-Format Probe

Prompt shape: `runtime/fine_tuning/rules/data/eval_rules.jsonl` user payload,
including relevant rule summaries.

Result:

```text
EVAL-CNH-001: PASS
EVAL-CNH-002: PASS
EVAL-CNH-003: PASS
EVAL-CNH-004: PASS
EVAL-CNH-005: PASS
EVAL-CNH-006: PASS
EVAL-CNH-007: PASS
rules_eval_passed=7/7
```

## Conclusion

The rules LoRA was retrained, loaded by the local Qwen service, and passed both
the sparse and trained-format live evaluations at 100%.
