# CyberNH System Scenario Fine-Tuning

This directory prepares a small SFT/LoRA dataset that teaches the local Qwen3-VL runtime to treat compact system tags as replacements for the long CyberNH system prompts.

For the full training design and operating procedure, see `TRAINING_METHOD.md`.

## Scenario Map

```text
[System Scenario 1] -> Worker-Agent system prompt
[System Scenario 2] -> Senior-Agent system prompt
[System Scenario 3] -> Assistant-Agent system prompt
```

The runtime code uses these tags by default. To fall back to the original long prompts:

```bash
CYBERNH_SYSTEM_PROMPT_MODE=full ./01_run_sim.sh
```

## Files

```text
metadata.json             # Dataset and scenario metadata
data/train.jsonl          # SFT training records
data/train_runtime.jsonl  # Runtime-shaped version of the base SFT records
data/train_augmented_runtime.jsonl # Current training file with boundary cases and regression anchors
data/eval.jsonl           # Held-out evaluation records
build_runtime_payload_dataset.py # Converts train.jsonl into runtime-shaped records
validate_dataset.py       # JSONL/schema sanity checks
train_lora.py             # Pure PyTorch LoRA training loop
run_lora_finetune.sh      # Project-aware wrapper for the external CyberNH-LLM venv
evaluate_adapter.py       # Load check and behavior evaluation for the running LLM
```

The original seed records are compact and readable. After conversion, the current runtime-shaped worker payload follows the shorter `compact_v2` protocol, where fixed schema rules are placed in the system prompt and the user message mainly carries dynamic state plus the demand table.

Each seed JSONL record has this shape:

```json
{
  "id": "stable-example-id",
  "scenario": "[System Scenario 1]",
  "agent_type": "Worker-Agent",
  "messages": [
    { "role": "system", "content": "[System Scenario 1]" },
    { "role": "user", "content": "{\"instruction\":\"...\",\"observation\":{...}}" },
    { "role": "assistant", "content": "{\"agent_id\":\"...\",\"action\":\"...\"}" }
  ]
}
```

## Validate

```bash
/Users/chongzhang/CyberNH-LLM/.venv/bin/python \
  runtime/fine_tuning/system_scenarios/validate_dataset.py \
  runtime/fine_tuning/system_scenarios/data/train.jsonl \
  runtime/fine_tuning/system_scenarios/data/train_runtime.jsonl \
  runtime/fine_tuning/system_scenarios/data/train_augmented_runtime.jsonl \
  runtime/fine_tuning/system_scenarios/data/eval.jsonl
```

## Build Runtime-Shaped Training Data

The first dataset is compact and human-readable. The running application sends richer payloads with output schemas, so training uses runtime-shaped records.

Base runtime data:

```bash
/Users/chongzhang/CyberNH-LLM/.venv/bin/python \
  runtime/fine_tuning/system_scenarios/build_runtime_payload_dataset.py \
  runtime/fine_tuning/system_scenarios/data/train.jsonl \
  runtime/fine_tuning/system_scenarios/data/train_runtime.jsonl
```

Current augmented training data:

```bash
/Users/chongzhang/CyberNH-LLM/.venv/bin/python \
  runtime/fine_tuning/system_scenarios/build_runtime_payload_dataset.py \
  runtime/fine_tuning/system_scenarios/data/train.jsonl \
  runtime/fine_tuning/system_scenarios/data/train_augmented_runtime.jsonl \
  --include-boundary-cases \
  --include-regression-anchors runtime/fine_tuning/system_scenarios/data/eval.jsonl \
  --repeat 2
```

`train_augmented_runtime.jsonl` intentionally includes behavior regression anchors. This is useful for making the local regression suite deterministic, but it should be read as a regression guarantee, not as proof of broad unseen-case generalization.

## Dry Run

This checks tokenizer/chat-template compatibility without loading the full model for training:

```bash
runtime/fine_tuning/system_scenarios/run_lora_finetune.sh --dry-run
```

## Train LoRA Adapter

Default standalone scenario-adapter output:

```text
/Users/chongzhang/CyberNH-LLM/adapters/system-scenarios-lora
```

Run a short local fine-tune:

```bash
runtime/fine_tuning/system_scenarios/run_lora_finetune.sh \
  --train-file runtime/fine_tuning/system_scenarios/data/train_augmented_runtime.jsonl \
  --max-steps 160 \
  --epochs 40 \
  --batch-size 1 \
  --grad-accum 1 \
  --learning-rate 0.0003 \
  --lora-rank 8 \
  --lora-alpha 16 \
  --lora-dropout 0
```

For a smoke test:

```bash
runtime/fine_tuning/system_scenarios/run_lora_finetune.sh --max-steps 1 --epochs 1
```

Historical standalone scenario adapter:

```text
/Users/chongzhang/CyberNH-LLM/adapters/system-scenarios-lora
train_file=runtime/fine_tuning/system_scenarios/data/train_augmented_runtime.jsonl
train_records=56
eval_records=6
steps=160
eval_loss=1.7205
behavior_eval=6/6 passed
```

Behavior evaluation is stricter than token loss: it checks whether the model follows each scenario tag in a runtime-shaped request and returns the expected structured action. The standalone scenario adapter is mainly useful for ablation or incremental training. In the current project workflow, its behavior has been carried forward into the default `rules-lora` adapter together with the rules dataset.

## Use Adapter

If you want to serve the standalone scenario adapter directly, set:

```bash
CYBERNH_LLM_ADAPTER_DIR=/Users/chongzhang/CyberNH-LLM/adapters/system-scenarios-lora
```

Then restart the local LLM:

```bash
CYBERNH_LLM_CHAT=0 CYBERNH_LLM_BACKGROUND=1 ./S1_Start_llm.sh
```

The CyberNH project already sends `[System Scenario 1]` for Worker-Agent LLM calls by default. Python Agent adapters use all three scenario tags by default.

## Evaluate Loaded Adapter

Start the LLM service without entering CLI chat:

```bash
CYBERNH_LLM_CHAT=0 ./S1_Start_llm.sh
```

Then run:

```bash
/Users/chongzhang/CyberNH-LLM/.venv/bin/python \
  runtime/fine_tuning/system_scenarios/evaluate_adapter.py
```

The evaluator first checks `/v1/health`. A loaded adapter should report:

```text
adapter_check=PASS expected_adapter=/Users/chongzhang/CyberNH-LLM/adapters/system-scenarios-lora
```

Latest behavior result:

```text
PASS eval_worker_ignore_broadcast
PASS eval_worker_unavailable
PASS eval_senior_waiting_but_threshold_not_met
PASS eval_senior_emergency_task
PASS eval_assistant_health_risk
PASS eval_assistant_care_mode_suggestion
summary: passed=6 failed=0 total=6
```
