#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
import random
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import torch
from torch.utils.data import DataLoader, Dataset
from transformers import AutoProcessor


@dataclass
class TrainConfig:
    model_dir: str
    train_file: str
    eval_file: str | None
    output_dir: str
    max_steps: int
    epochs: int
    batch_size: int
    grad_accum: int
    learning_rate: float
    max_length: int
    lora_rank: int
    lora_alpha: int
    lora_dropout: float
    device: str
    dtype: str
    seed: int
    manifest_task: str
    manifest_file: str


class ScenarioDataset(Dataset):
    def __init__(self, records: list[dict[str, Any]], processor: Any, max_length: int):
        self.records = records
        self.processor = processor
        self.tokenizer = getattr(processor, "tokenizer", processor)
        self.max_length = max_length

    def __len__(self) -> int:
        return len(self.records)

    def __getitem__(self, index: int) -> dict[str, list[int]]:
        messages = normalize_messages(self.records[index]["messages"])
        prompt_messages = messages[:-1]

        prompt_text = self.processor.apply_chat_template(
            prompt_messages,
            tokenize=False,
            add_generation_prompt=True,
        )
        full_text = self.processor.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=False,
        )

        prompt_ids = self.tokenizer(prompt_text, add_special_tokens=False)["input_ids"]
        full_ids = self.tokenizer(full_text, add_special_tokens=False)["input_ids"]
        if len(full_ids) > self.max_length:
            full_ids = full_ids[-self.max_length :]
            prompt_len = max(0, min(len(prompt_ids), len(full_ids) - 1))
        else:
            prompt_len = min(len(prompt_ids), len(full_ids))

        labels = list(full_ids)
        for pos in range(prompt_len):
            labels[pos] = -100
        return {"input_ids": full_ids, "labels": labels}


def normalize_messages(messages: list[dict[str, str]]) -> list[dict[str, Any]]:
    return [
        {"role": message["role"], "content": [{"type": "text", "text": message["content"]}]}
        for message in messages
    ]


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parent
    default_llm_dir = Path(os.getenv("CYBERNH_LLM_DIR", "/Users/chongzhang/CyberNH-LLM"))
    parser = argparse.ArgumentParser(description="LoRA fine-tune Qwen3-VL for CyberNH system scenario tags.")
    parser.add_argument("--model-dir", default=os.getenv("CYBERNH_LLM_LOCAL_DIR", str(default_llm_dir / "models" / "Qwen3-VL-2B-Instruct")))
    parser.add_argument("--train-file", default=str(root / "data" / "train_augmented_runtime.jsonl"))
    parser.add_argument("--eval-file", default=str(root / "data" / "eval.jsonl"))
    parser.add_argument("--output-dir", default=str(default_llm_dir / "adapters" / "system-scenarios-lora"))
    parser.add_argument("--max-steps", type=int, default=160)
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--grad-accum", type=int, default=1)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--max-length", type=int, default=2048)
    parser.add_argument("--lora-rank", type=int, default=8)
    parser.add_argument("--lora-alpha", type=int, default=16)
    parser.add_argument("--lora-dropout", type=float, default=0.0)
    parser.add_argument("--device", default=os.getenv("CYBERNH_LLM_DEVICE", "auto"))
    parser.add_argument("--dtype", default=os.getenv("CYBERNH_LLM_DTYPE", "auto"))
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--manifest-task", default="CyberNH system scenario prompt compression")
    parser.add_argument("--manifest-file", default="cybernh_system_scenarios_manifest.json")
    parser.add_argument("--manifest-extra-json", default=None, help="Optional JSON object merged into the adapter manifest.")
    parser.add_argument("--dry-run", action="store_true", help="Validate data and tokenization without loading the model.")
    return parser.parse_args()


def load_records(path: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                records.append(json.loads(line))
    if not records:
        raise ValueError(f"No records found in {path}")
    return records


def collate_batch(batch: list[dict[str, list[int]]], pad_token_id: int) -> dict[str, torch.Tensor]:
    max_len = max(len(item["input_ids"]) for item in batch)
    input_ids = []
    attention_mask = []
    labels = []
    for item in batch:
        pad_len = max_len - len(item["input_ids"])
        input_ids.append(item["input_ids"] + [pad_token_id] * pad_len)
        attention_mask.append([1] * len(item["input_ids"]) + [0] * pad_len)
        labels.append(item["labels"] + [-100] * pad_len)
    return {
        "input_ids": torch.tensor(input_ids, dtype=torch.long),
        "attention_mask": torch.tensor(attention_mask, dtype=torch.long),
        "labels": torch.tensor(labels, dtype=torch.long),
    }


def choose_device(name: str) -> torch.device:
    requested = name.lower()
    if requested != "auto":
        return torch.device(requested)
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def choose_dtype(name: str, device: torch.device) -> torch.dtype:
    requested = name.lower()
    if requested in ("float32", "fp32"):
        return torch.float32
    if requested in ("float16", "fp16", "half"):
        return torch.float16
    if requested in ("bfloat16", "bf16"):
        return torch.bfloat16
    if device.type == "cuda":
        return torch.bfloat16
    if device.type == "mps":
        return torch.float16
    return torch.float32


def seed_everything(seed: int) -> None:
    random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def load_model(model_dir: str, dtype: torch.dtype):
    try:
        from transformers import Qwen3VLForConditionalGeneration

        model_cls = Qwen3VLForConditionalGeneration
    except ImportError:
        from transformers import AutoModelForImageTextToText

        model_cls = AutoModelForImageTextToText
    return model_cls.from_pretrained(
        model_dir,
        dtype=dtype,
        low_cpu_mem_usage=True,
        trust_remote_code=True,
    )


def infer_lora_targets(model: torch.nn.Module) -> list[str]:
    preferred = {"q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"}
    found = set()
    for name, module in model.named_modules():
        if module.__class__.__name__ != "Linear":
            continue
        suffix = name.rsplit(".", 1)[-1]
        if suffix in preferred:
            found.add(suffix)
    if not found:
        raise RuntimeError("No LoRA target modules were found.")
    return sorted(found)


def evaluate_loss(model: torch.nn.Module, loader: DataLoader, device: torch.device) -> float:
    model.eval()
    losses = []
    with torch.no_grad():
        for batch in loader:
            batch = {key: value.to(device) for key, value in batch.items()}
            loss = model(**batch).loss
            losses.append(float(loss.detach().cpu()))
    model.train()
    return sum(losses) / max(1, len(losses))


def write_manifest(
    output_dir: Path,
    config: TrainConfig,
    train_count: int,
    eval_count: int,
    final_loss: float | None,
    manifest_extra: dict[str, Any] | None = None,
) -> None:
    manifest = {
        "created_at": int(time.time()),
        "adapter_type": "lora",
        "task": config.manifest_task,
        "scenario_map": {
            "[System Scenario 1]": "Worker-Agent",
            "[System Scenario 2]": "Senior-Agent",
            "[System Scenario 3]": "Assistant-Agent",
        },
        "train_records": train_count,
        "eval_records": eval_count,
        "final_eval_loss": final_loss,
        "config": asdict(config),
    }
    if manifest_extra:
        manifest.update(manifest_extra)
    (output_dir / config.manifest_file).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def main() -> int:
    args = parse_args()
    config = TrainConfig(
        model_dir=args.model_dir,
        train_file=args.train_file,
        eval_file=args.eval_file,
        output_dir=args.output_dir,
        max_steps=args.max_steps,
        epochs=args.epochs,
        batch_size=args.batch_size,
        grad_accum=args.grad_accum,
        learning_rate=args.learning_rate,
        max_length=args.max_length,
        lora_rank=args.lora_rank,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        device=args.device,
        dtype=args.dtype,
        seed=args.seed,
        manifest_task=args.manifest_task,
        manifest_file=args.manifest_file,
    )
    manifest_extra = json.loads(args.manifest_extra_json) if args.manifest_extra_json else None

    seed_everything(args.seed)
    train_records = load_records(args.train_file)
    eval_records = load_records(args.eval_file) if args.eval_file else []
    processor = AutoProcessor.from_pretrained(args.model_dir, trust_remote_code=True)
    tokenizer = getattr(processor, "tokenizer", processor)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token

    train_dataset = ScenarioDataset(train_records, processor, args.max_length)
    eval_dataset = ScenarioDataset(eval_records, processor, args.max_length) if eval_records else None
    lengths = [len(train_dataset[index]["input_ids"]) for index in range(len(train_dataset))]
    print(f"train_records={len(train_records)} eval_records={len(eval_records)} seed={args.seed}")
    print(f"token_length min={min(lengths)} max={max(lengths)} avg={sum(lengths) / len(lengths):.1f}")
    if args.dry_run:
        print("dry_run=1; data and tokenization are valid.")
        return 0

    try:
        from peft import LoraConfig, get_peft_model
    except ImportError as exc:
        raise RuntimeError(
            "peft is required for LoRA fine-tuning. Install with: "
            f"{Path(os.getenv('CYBERNH_LLM_DIR', '/Users/chongzhang/CyberNH-LLM')) / '.venv' / 'bin' / 'python'} "
            "-m pip install peft"
        ) from exc

    device = choose_device(args.device)
    dtype = choose_dtype(args.dtype, device)
    print(f"loading model={args.model_dir}")
    print(f"device={device} dtype={dtype}")
    model = load_model(args.model_dir, dtype)
    if hasattr(model, "gradient_checkpointing_enable"):
        model.gradient_checkpointing_enable()
    if hasattr(model, "config"):
        model.config.use_cache = False

    targets = infer_lora_targets(model)
    print(f"lora_targets={','.join(targets)}")
    lora_config = LoraConfig(
        r=args.lora_rank,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=targets,
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()
    model.to(device)
    model.train()

    data_generator = torch.Generator()
    data_generator.manual_seed(args.seed)
    train_loader = DataLoader(
        train_dataset,
        batch_size=args.batch_size,
        shuffle=True,
        generator=data_generator,
        collate_fn=lambda batch: collate_batch(batch, tokenizer.pad_token_id),
    )
    eval_loader = (
        DataLoader(
            eval_dataset,
            batch_size=1,
            shuffle=False,
            collate_fn=lambda batch: collate_batch(batch, tokenizer.pad_token_id),
        )
        if eval_dataset is not None
        else None
    )
    optimizer = torch.optim.AdamW((p for p in model.parameters() if p.requires_grad), lr=args.learning_rate)
    steps_per_epoch = math.ceil(len(train_loader) / max(1, args.grad_accum))
    target_steps = args.max_steps if args.max_steps > 0 else steps_per_epoch * args.epochs
    global_step = 0
    running_loss = 0.0
    accumulated_micro_batches = 0
    optimizer.zero_grad(set_to_none=True)

    for epoch in range(args.epochs):
        for batch in train_loader:
            batch = {key: value.to(device) for key, value in batch.items()}
            raw_loss = model(**batch).loss
            loss = raw_loss / args.grad_accum
            loss.backward()
            running_loss += float(raw_loss.detach().cpu())
            accumulated_micro_batches += 1
            if accumulated_micro_batches >= args.grad_accum:
                optimizer.step()
                optimizer.zero_grad(set_to_none=True)
                global_step += 1
                print(f"step={global_step} epoch={epoch + 1} loss={running_loss / accumulated_micro_batches:.4f}")
                running_loss = 0.0
                accumulated_micro_batches = 0
                if global_step >= target_steps:
                    break
        if accumulated_micro_batches > 0 and global_step < target_steps:
            optimizer.step()
            optimizer.zero_grad(set_to_none=True)
            global_step += 1
            print(f"step={global_step} epoch={epoch + 1} loss={running_loss / accumulated_micro_batches:.4f}")
            running_loss = 0.0
            accumulated_micro_batches = 0
        if global_step >= target_steps:
            break

    final_eval_loss = evaluate_loss(model, eval_loader, device) if eval_loader is not None else None
    if final_eval_loss is not None:
        print(f"eval_loss={final_eval_loss:.4f}")

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(output_dir)
    processor.save_pretrained(output_dir)
    write_manifest(output_dir, config, len(train_records), len(eval_records), final_eval_loss, manifest_extra)
    print(f"saved_adapter={output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
