# CyberNH System Scenario Fine-Tuning

This directory prepares a small SFT/LoRA dataset that teaches the local Qwen3-VL runtime to treat compact system tags as replacements for the long CyberNH system prompts.

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
data/eval.jsonl           # Held-out evaluation records
validate_dataset.py       # JSONL/schema sanity checks
train_lora.py             # Pure PyTorch LoRA training loop
run_lora_finetune.sh      # Project-aware wrapper for the external CyberNH-LLM venv
```

Each JSONL record has this shape:

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
  runtime/fine_tuning/system_scenarios/data/eval.jsonl
```

## Dry Run

This checks tokenizer/chat-template compatibility without loading the full model for training:

```bash
runtime/fine_tuning/system_scenarios/run_lora_finetune.sh --dry-run
```

## Train LoRA Adapter

Default output:

```text
/Users/chongzhang/CyberNH-LLM/adapters/system-scenarios-lora
```

Run a short local fine-tune:

```bash
runtime/fine_tuning/system_scenarios/run_lora_finetune.sh \
  --max-steps 30 \
  --epochs 8 \
  --batch-size 1 \
  --grad-accum 4
```

For a smoke test:

```bash
runtime/fine_tuning/system_scenarios/run_lora_finetune.sh --max-steps 1 --epochs 1
```

Current completed adapter:

```text
/Users/chongzhang/CyberNH-LLM/adapters/system-scenarios-lora
train_records=17
eval_records=6
steps=8
eval_loss=1.7399
```

## Use Adapter

The external LLM `.env` is currently configured with:

```bash
CYBERNH_LLM_ADAPTER_DIR=/Users/chongzhang/CyberNH-LLM/adapters/system-scenarios-lora
```

Then restart the local LLM:

```bash
CYBERNH_LLM_CHAT=0 CYBERNH_LLM_BACKGROUND=1 ./S1_Start_llm.sh
```

The CyberNH project already sends `[System Scenario 1]` for Worker-Agent LLM calls by default. Python Agent adapters use all three scenario tags by default.
