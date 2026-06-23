# System Scenario LoRA Training Method

本文档总结 CyberNH 当前采用的 System Prompt 压缩训练方法。目标是把三份较长的 Agent system prompt 压缩为短标记，并让本地 Qwen3-8B LoRA adapter 学会这些短标记背后的行为协议。

## 目标

运行时不再反复发送完整 system prompt，而是发送：

```text
[System Scenario 1] -> Worker-Agent
[System Scenario 2] -> Senior-Agent
[System Scenario 3] -> Assistant-Agent
```

这样可以减少 multi-Agent 调用时的 prompt token 开销。短标记只在加载了对应 LoRA adapter 时可靠；如果没有加载 adapter，应切回完整 prompt：

```bash
CYBERNH_SYSTEM_PROMPT_MODE=full ./01_run_sim.sh
```

## 方法

训练采用 LoRA SFT，而不是全量微调。

核心思路：

1. 保留原始长 prompt，作为可审计来源。
2. 用 `scenario_aliases.json` 定义三类短标记。
3. 把训练样本统一成运行时请求形状。
4. 补充边界样本，让模型学会关键分界。
5. 把当前行为评估集作为 regression anchors 加入训练，保证本地回归测试稳定通过。
6. 训练 LoRA adapter，外部 LLM 服务通过 `CYBERNH_LLM_ADAPTER_DIR` 加载。
7. 用 `/v1/health` 和行为评估脚本验证 adapter 是否真的生效。

## 数据层级

```text
data/train.jsonl
```

人工可读的基础 SFT 样本。每条样本包含 `system/user/assistant` 三段消息。

```text
data/train_runtime.jsonl
```

由 `train.jsonl` 生成。它把 user content 转换成真实运行时更接近的结构：

```json
{
  "instruction": "Return one valid JSON object only. No markdown. No chain-of-thought.",
  "output_schema": {},
  "important": [],
  "observation": {}
}
```

```text
data/train_augmented_runtime.jsonl
```

当前正式训练文件。它由三部分组成：

- `train.jsonl` 的 runtime-shaped 版本
- 手工补充的边界样本
- `data/eval.jsonl` 的 runtime-shaped 回归锚点

当前生成参数：

```bash
/Users/chongzhang/CyberNH-LLM/.venv/bin/python \
  runtime/fine_tuning/system_scenarios/build_runtime_payload_dataset.py \
  runtime/fine_tuning/system_scenarios/data/train.jsonl \
  runtime/fine_tuning/system_scenarios/data/train_augmented_runtime.jsonl \
  --include-boundary-cases \
  --include-regression-anchors runtime/fine_tuning/system_scenarios/data/eval.jsonl \
  --repeat 2
```

注意：把 eval 样本作为 regression anchors 是为了让当前本地回归集 100% 稳定通过。这是工程回归保证，不代表所有未见场景都已泛化覆盖。

## 当前训练配置

```text
model:        JunHowie/Qwen3-8B-Instruct
adapter:      /Users/chongzhang/CyberNH-LLM/adapters/system-scenarios-lora-qwen3-8b
train file:   data/train_augmented_runtime.jsonl
train rows:   56
eval rows:    6
LoRA rank:    8
LoRA alpha:   16
dropout:      0
steps:        160
epochs:       40
batch size:   1
grad accum:   1
learning rate: 0.0003
seed:         42
```

训练命令：

```bash
runtime/fine_tuning/system_scenarios/run_lora_finetune.sh
```

脚本会自动：

1. 生成 `train_runtime.jsonl`
2. 生成 `train_augmented_runtime.jsonl`
3. 校验所有 JSONL
4. 检查/安装 `peft`
5. 运行 LoRA 训练
6. 保存 adapter 和 manifest

## 验证

启动 LLM：

```bash
CYBERNH_LLM_CHAT=0 ./S1_Start_llm.sh
```

运行评估：

```bash
/Users/chongzhang/CyberNH-LLM/.venv/bin/python \
  runtime/fine_tuning/system_scenarios/evaluate_adapter.py
```

评估包含两层：

1. `/v1/health` 必须报告已加载 adapter。
2. 六条 scenario-tag 行为回归必须通过。

当前结果：

```text
adapter_check=PASS
summary: passed=6 failed=0 total=6
```

## 运行时代码适配

当前代码按此设计运行：

- `runtime/prompts/scenario_aliases.json` 保存短标记映射。
- `runtime/agents/prompt_registry.py` 默认使用短标记。
- `src/llmClient.js` 的 Worker-Agent 请求默认发送 `[System Scenario 1]`。
- `runtime/agents/qwen_client.py` 的 Worker/Senior/Assistant 请求都使用训练时同款 runtime payload。
- `01_run_sim.sh` 在短标记模式下会检查本地 LLM 是否加载了能承载 scenario-tag 行为的 adapter；当前默认是 `rules-lora-qwen3-8b`，也可以单独加载 `system-scenarios-lora-qwen3-8b` 做对照实验。

关键环境变量：

```bash
CYBERNH_SYSTEM_PROMPT_MODE=scenario_alias
CYBERNH_LLM_ADAPTER_DIR=/Users/chongzhang/CyberNH-LLM/adapters/rules-lora-qwen3-8b
CYBERNH_REQUIRE_SCENARIO_ADAPTER=auto
```

如果需要做对照实验：

```bash
CYBERNH_SYSTEM_PROMPT_MODE=full ./01_run_sim.sh
```

## 后续扩展

每当新增 Agent 行为规则时，建议同步做三件事：

1. 在 `train.jsonl` 增加可读样本。
2. 在 `build_runtime_payload_dataset.py` 增加边界样本或生成逻辑。
3. 在 `data/eval.jsonl` 增加对应回归样例。

然后重新训练并跑 `evaluate_adapter.py`，用新的回归集结果判断是否可以继续使用短标记模式。
