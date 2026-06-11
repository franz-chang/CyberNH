# CyberNH Rules LoRA

This directory builds and trains a LoRA adapter that teaches the local Qwen3-VL runtime the curated rules under `rules/`.

It reuses the same training parameters as `runtime/fine_tuning/system_scenarios/run_lora_finetune.sh`:

- max steps: `160`
- epochs: `40`
- batch size: `1`
- gradient accumulation: `1`
- learning rate: `3e-4`
- LoRA rank: `8`
- LoRA alpha: `16`
- LoRA dropout: `0`

The generated training set combines:

- `rules/datasets/train_seed.jsonl`
- `rules/datasets/eval_cases.jsonl`
- `rules/structured/rules.jsonl`
- `rules/structured/metrics.jsonl`
- existing system scenario runtime anchors, so the adapter keeps the compact System Scenario behavior.

Run:

```bash
runtime/fine_tuning/rules/run_lora_finetune.sh
```

Default output:

```text
/Users/chongzhang/CyberNH-LLM/adapters/rules-lora
```

To serve the local model with this adapter:

```bash
CYBERNH_LLM_ADAPTER_DIR=/Users/chongzhang/CyberNH-LLM/adapters/rules-lora ./S1_Start_llm.sh
```
