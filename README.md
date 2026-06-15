# CyberNH

CyberNH 是一个面向养老院照护场景的多智能体仿真项目。它把老人需求、护理员资源、护理策略、设施地图、任务队列和 LLM 决策过程放在同一个可视化面板里，用来观察不同配置下的照护系统如何运行。

当前项目重点不是做一个静态演示页，而是一个可以运行、调参、监听队列、查看 LLM 输入输出、导出实验数据的本地仿真工作台。


![CyberNH示意图](fig.jpg)

## 核心能力

- 养老院 40 房间地图仿真：护理员、老人、需求点和路线会在地图上实时更新。
- 双队列运行机制：Queue1 展示老人需求，Queue2 展示护理员和 Assistant 的调度记录。
- Worker / Senior / Assistant Agent 提示词：位于 `runtime/prompts/`，用于约束不同角色的行为。
- OpenAI-compatible LLM 接口：Worker-Agent 可通过本地或远程 LLM 生成结构化决策。
- 本地 Qwen3-VL 运行支持：LLM 目录已移出仓库，默认放在项目同级的 `CyberNH-LLM`。
- 可视化调参面板：班次、人力、需求强度、照护模式、Agent 决策模式等均可在前端调整。
- 中英文国际化：右上角 `中文 / English` 按钮可以切换面板显示语言。
- 规则数据集：`rules/` 中包含从规则 PDF 抽取、结构化和整理后的训练/评估数据。

## 目录结构

```text
CyberNH/
├── 01_run_sim.sh              # 总启动脚本：启动 LLM 并运行仿真面板
├── S1_Start_llm.sh            # 只启动本地 LLM，并可进入 CLI 连续对话
├── L1_listen_queues.sh        # 监听 Queue1 / Queue2
├── L2_listen_llm.sh           # 监听 Worker-Agent 的 LLM 输入输出
├── server.js                  # Node.js HTTP/WebSocket 服务
├── src/                       # 仿真核心、地图、LLM client、随机数等
├── public/                    # 前端页面、样式和交互逻辑
├── runtime/
│   ├── agents/                # Python Agent 适配层和 schema
│   └── prompts/               # Worker/Senior/Assistant system prompts
└── rules/                     # 规则 PDF、抽取文本、结构化规则和数据集说明
```

LLM 运行目录不在本仓库内：

```text
/Users/chongzhang/CyberNH-LLM
```

这个目录用于放模型权重、Python 虚拟环境、Transformers/OpenAI-compatible 服务脚本等重资产。它不进入 Git 仓库。

## 环境要求

- Node.js `>=18`
- npm
- curl
- macOS / Linux 均可运行仿真面板
- 本地 LLM 运行需要额外准备 `CyberNH-LLM` 目录和模型文件

安装 Node 依赖：

```bash
npm install
```

检查项目语法：

```bash
npm run check
```

## 快速启动

### 1. 使用本地 LLM 启动完整仿真

默认情况下，项目会寻找同级目录：

```text
/Users/chongzhang/CyberNH-LLM
```

启动：

```bash
./01_run_sim.sh
```

脚本会做这些事：

- 读取 `CyberNH-LLM/.env`
- 检查本地 LLM endpoint 是否可用
- 如 endpoint 未运行，则尝试启动本地 Qwen3-VL 服务
- 等待 LLM 服务 ready
- 启动 CyberNH 仿真面板

面板地址会在终端输出，默认从 `http://localhost:4173` 开始，如端口被占用会自动递增。

### 2. 只启动仿真面板，不自动启动 LLM

如果你已经有远程或外部 OpenAI-compatible endpoint：

```bash
CYBERNH_START_LLM=0 \
CYBERNH_LLM_BASE_URL=http://your-llm-host:8000/v1 \
CYBERNH_LLM_API_KEY=EMPTY \
./01_run_sim.sh
```

### 3. 使用 DeepSeek API 驱动 Agent 决策

DeepSeek API 分支不依赖本地 LoRA / adapter，因此项目会为 Worker-Agent 发送完整 `runtime/prompts/worker_agent.system.md`，而不是短标记 System Scenario。

DeepSeek 参数文件位于：

```text
config/deepseek.env
```

填入 API key 后直接启动：

```bash
./01_run_sim.sh
```

参数文件内容示例：

```bash
CYBERNH_DEFAULT_AGENT_DECISION_MODE=deepseek_api
CYBERNH_DEEPSEEK_API_KEY=sk-...
CYBERNH_DEEPSEEK_BASE_URL=https://api.deepseek.com
CYBERNH_DEEPSEEK_MODEL=deepseek-v4-flash
CYBERNH_DEEPSEEK_TEMPERATURE=0
CYBERNH_DEEPSEEK_MAX_TOKENS=512
CYBERNH_DEEPSEEK_TIMEOUT_SECONDS=120
CYBERNH_DEEPSEEK_JSON_MODE=true
CYBERNH_DEEPSEEK_THINKING=disabled
```

`config/deepseek.env` 已被 `.gitignore` 忽略，不会提交真实 API key。命令行中显式传入的环境变量仍然优先。

也可以在前端 `照护策略 -> Agent 决策` 中切换到 `DeepSeek API 驱动`。该模式使用 DeepSeek 的 OpenAI-compatible `/chat/completions` 接口，并开启 JSON Output。

### 4. 只启动本地 LLM

```bash
./S1_Start_llm.sh
```

默认会启动 LLM 服务，并进入 CLI 连续对话。

常用模式：

```bash
# 只启动服务，不进入 CLI 对话
CYBERNH_LLM_CHAT=0 ./S1_Start_llm.sh

# 后台启动服务并保持运行
CYBERNH_LLM_CHAT=0 CYBERNH_LLM_BACKGROUND=1 ./S1_Start_llm.sh

# 退出 CLI 后不停止 LLM 服务
CYBERNH_LLM_KEEP_ALIVE=1 ./S1_Start_llm.sh
```

如果 LLM 目录放在其他位置：

```bash
CYBERNH_LLM_DIR=/absolute/path/to/CyberNH-LLM ./S1_Start_llm.sh
```

## 监听工具

### 监听队列

```bash
./L1_listen_queues.sh
```

常用参数：

```bash
./L1_listen_queues.sh --auto
./L1_listen_queues.sh --manual-demand 3
./L1_listen_queues.sh --once
```

### 监听 LLM 输入输出

```bash
./L2_listen_llm.sh
```

常用参数：

```bash
./L2_listen_llm.sh --auto
./L2_listen_llm.sh --manual-demand 3
```

这个脚本只打印 Worker-Agent 的 LLM request / reply，适合调试提示词、schema 和模型决策质量。

## LLM 配置

### 本项目当前 LLM 设置

本项目当前使用本地 Qwen3-VL，提供 OpenAI-compatible 接口给 CyberNH 调用。

```text
Provider:       modelscope-transformers
Model ID:       Qwen/Qwen3-VL-2B-Instruct
Served model:   qwen3-vl-2b-instruct
Endpoint:       http://localhost:8000/v1
Chat API:       http://localhost:8000/v1/chat/completions
Runtime dir:    /Users/chongzhang/CyberNH-LLM
Model dir:      /Users/chongzhang/CyberNH-LLM/models/Qwen3-VL-2B-Instruct
Python venv:    /Users/chongzhang/CyberNH-LLM/.venv
```

LLM 目录是一个独立运行目录，不随 Git 仓库提交。这样可以避免把模型权重、虚拟环境、下载缓存和日志推到 GitHub。

### 2B-Instruct 驱动模型处理流程

项目中用于驱动 Agent 决策的基础模型是 `Qwen/Qwen3-VL-2B-Instruct`。我们没有把模型权重放入 Git 仓库，而是将它作为外部运行资产放在同级 `CyberNH-LLM` 目录中，由 ModelScope 下载脚本负责获取和更新。仓库内只保留启动脚本、提示词、数据集、微调脚本和评估脚本。

2B-Instruct 的处理流程分为四步：

1. **模型部署**：使用 `download_model.sh` 从 ModelScope 下载 `Qwen/Qwen3-VL-2B-Instruct`，并通过外部 `.env` 指定 `CYBERNH_LLM_LOCAL_DIR`、`CYBERNH_LLM_MODEL` 和 endpoint 配置。
2. **服务封装**：使用 Transformers 后端加载本地模型，并通过 `serve_transformers_openai.py` 包装成 OpenAI-compatible 服务，提供 `/v1/models`、`/v1/chat/completions` 和 `/health` 接口。CyberNH 只依赖这个标准接口，不直接耦合底层推理实现。
3. **System Scenario 适配**：将 Worker / Senior / Assistant 的长 system prompt 压缩成 `[System Scenario 1]`、`[System Scenario 2]`、`[System Scenario 3]` 三个短标记，并用 runtime-shaped LoRA 数据让 2B-Instruct 学会这些短标记背后的结构化决策协议。
4. **规则适配**：将 `rules/` 中从规则 PDF 抽取、结构化后的优先级、抢占、双人任务、隐性工作量和指标规则转换为监督样本，再训练 rules LoRA，使 2B-Instruct 在不反复发送长规则文本的情况下仍能输出符合规则的 JSON 决策。

因此，运行时的 2B-Instruct 不是裸基模直接决策，而是经过以下约束链路：

```text
Qwen3-VL-2B-Instruct
  -> OpenAI-compatible local endpoint
  -> System Scenario prompt-compression adapter
  -> rules / priority-reasoning adapter
  -> CyberNH structured Agent decision JSON
```

当使用本地 2B-Instruct + adapter 驱动时，项目默认发送短 scenario 标记以减少 prompt token 开销。如果没有加载对应 adapter，或需要做保守对照实验，可以切回完整 system prompt：

```bash
CYBERNH_SYSTEM_PROMPT_MODE=full ./01_run_sim.sh
```

需要注意的是，LoRA adapter 与基模结构绑定。针对 `Qwen3-VL-2B-Instruct` 训练得到的 adapter 不能直接挂到 `Qwen3-VL-4B-Instruct` 上；如果切换到 4B，需要使用同一数据流程重新训练对应 adapter。

当前外部 LLM 目录应包含：

```text
CyberNH-LLM/
├── .env                         # 本机实际配置，不进 Git
├── .env.example                 # 示例配置
├── README.md                    # LLM 运行目录说明
├── requirements.txt             # ModelScope/Transformers 依赖
├── setup_modelscope.sh          # 创建/更新 Python venv
├── download_model.sh            # 下载 Qwen3-VL 模型
├── serve_transformers.sh        # 启动 Transformers 服务
├── serve_transformers_openai.py # OpenAI-compatible server
├── serve_vllm.sh                # NVIDIA Linux/vLLM 可选入口
├── chat_cli.py                  # CLI 连续对话入口
├── .venv/                       # Python 虚拟环境
└── models/
    └── Qwen3-VL-2B-Instruct/
```

### 首次准备 LLM 运行目录

如果是在这台机器上继续开发，默认目录已经是：

```text
/Users/chongzhang/CyberNH-LLM
```

如果迁移到新机器，需要先准备同级外部目录，并在其中放置 LLM 运行脚本和 `.env.example`，然后执行：

```bash
cd /Users/chongzhang/CyberNH-LLM
./setup_modelscope.sh
./download_model.sh
```

`setup_modelscope.sh` 会创建或更新：

```text
/Users/chongzhang/CyberNH-LLM/.venv
```

`download_model.sh` 会下载模型到：

```text
/Users/chongzhang/CyberNH-LLM/models/Qwen3-VL-2B-Instruct
```

### .env 示例

项目通过环境变量读取 LLM 配置。默认值通常来自外部目录：

```text
/Users/chongzhang/CyberNH-LLM/.env
```

当前推荐配置：

```bash
CYBERNH_LLM_DIR=/Users/chongzhang/CyberNH-LLM
CYBERNH_LLM_PROVIDER=modelscope-transformers
CYBERNH_LLM_MODEL=qwen3-vl-2b-instruct
CYBERNH_LLM_MODEL_ID=Qwen/Qwen3-VL-2B-Instruct
CYBERNH_LLM_BASE_URL=http://localhost:8000/v1
CYBERNH_LLM_API_KEY=EMPTY
CYBERNH_LLM_TEMPERATURE=0
CYBERNH_LLM_MAX_TOKENS=512
CYBERNH_LLM_TIMEOUT_SECONDS=120
CYBERNH_LLM_JSON_MODE=true
CYBERNH_LLM_LOCAL_DIR=/Users/chongzhang/CyberNH-LLM/models/Qwen3-VL-2B-Instruct
CYBERNH_LLM_DEVICE=auto
CYBERNH_LLM_DTYPE=auto
CYBERNH_LLM_READY_TIMEOUT_SECONDS=600
```

不要在 `.env` 中提交真实 API key。本仓库不会提交 `.env`、模型权重、虚拟环境和日志。

### 启动本地 Qwen3-VL 服务

推荐从 CyberNH 项目目录启动：

```bash
cd /Users/chongzhang/CyberNH
./S1_Start_llm.sh
```

这个脚本会读取 `/Users/chongzhang/CyberNH-LLM/.env`，检查模型文件和虚拟环境，然后启动：

```bash
/Users/chongzhang/CyberNH-LLM/serve_transformers.sh
```

服务 ready 后，`S1_Start_llm.sh` 默认会进入 CLI 连续对话。CLI 命令：

```text
/help      显示命令
/reset     清空当前对话历史
/history   查看当前消息数
/exit      退出 CLI
```

如果只想启动服务：

```bash
CYBERNH_LLM_CHAT=0 ./S1_Start_llm.sh
```

如果要后台启动并保持运行：

```bash
CYBERNH_LLM_CHAT=0 CYBERNH_LLM_BACKGROUND=1 ./S1_Start_llm.sh
```

### 设备与后端

默认后端是 Transformers，适合 macOS/Apple Silicon 的本地测试。设备选择由下面两个变量控制：

```bash
CYBERNH_LLM_DEVICE=auto   # auto, mps, cuda, cpu
CYBERNH_LLM_DTYPE=auto    # auto, float16, bfloat16, float32
```

在 macOS 上，`auto` 会优先尝试 MPS。若迁移到 NVIDIA Linux 主机，可以考虑使用外部目录中的 `serve_vllm.sh`，但需要先在该 venv 中安装 vLLM。

### 远程 LLM 替代方案

如果不使用本地 Qwen3-VL，只要目标服务兼容 OpenAI Chat Completions API，就可以这样运行：

```bash
CYBERNH_START_LLM=0 \
CYBERNH_LLM_PROVIDER=openai-compatible \
CYBERNH_LLM_BASE_URL=http://your-llm-host:8000/v1 \
CYBERNH_LLM_API_KEY=your-key \
CYBERNH_LLM_MODEL=your-served-model \
./01_run_sim.sh
```

## Agent 与提示词

提示词位于：

```text
runtime/prompts/
├── assistant_agent.system.md
├── senior_agent.system.md
└── worker_agent.system.md
```

LLM 输出需要符合结构化决策协议。相关 schema 和适配层位于：

```text
runtime/agents/
src/llmClient.js
```

仿真器会校验 Worker-Agent 的目标需求是否合法，避免模型选择不在候选集中的 demand。

## System Scenario 微调

为减少 multi-Agent 运行时反复发送长 system prompt 的 token 开销，本项目已把三类 system prompt 压缩为短标记：

```text
[System Scenario 1] -> Worker-Agent
[System Scenario 2] -> Senior-Agent
[System Scenario 3] -> Assistant-Agent
```

运行时代码默认使用短标记：

- Python/CAMEL 侧：`runtime/agents/prompt_registry.py`
- Node Worker LLM 侧：`src/llmClient.js`
- 映射文件：`runtime/prompts/scenario_aliases.json`

如需临时退回原始长 prompt：

```bash
CYBERNH_SYSTEM_PROMPT_MODE=full ./01_run_sim.sh
```

微调数据与脚本位于：

```text
runtime/fine_tuning/system_scenarios/
├── data/train.jsonl
├── data/train_runtime.jsonl
├── data/train_augmented_runtime.jsonl
├── data/eval.jsonl
├── build_runtime_payload_dataset.py
├── evaluate_adapter.py
├── validate_dataset.py
├── train_lora.py
└── run_lora_finetune.sh
```

训练方法说明见：

```text
runtime/fine_tuning/system_scenarios/TRAINING_METHOD.md
```

已完成一次 runtime-shaped LoRA 微调，并验证 adapter 已被本地 LLM 服务加载。adapter 产物位于外部 LLM 目录：

```text
/Users/chongzhang/CyberNH-LLM/adapters/system-scenarios-lora
```

训练摘要：

```text
train records: 56
eval records:  6
LoRA rank:     8
trainable:     8,716,288 params
steps:         160
eval loss:     1.7205
behavior eval: 6/6 passed
```

行为评估会先检查 `/v1/health` 是否报告了当前 adapter，再用 `[System Scenario 1]`、`[System Scenario 2]`、`[System Scenario 3]` 跑结构化决策样例。当前训练方法使用 runtime-shaped 数据、边界样本和行为回归锚点，已让本地 6 条 scenario-tag 行为回归全部通过。这个 100% 是当前回归集口径，不等价于所有未见场景都已覆盖。保守运行时仍可继续使用：

```bash
CYBERNH_SYSTEM_PROMPT_MODE=full ./01_run_sim.sh
```

外部 LLM `.env` 已启用：

```bash
CYBERNH_LLM_ADAPTER_DIR=/Users/chongzhang/CyberNH-LLM/adapters/system-scenarios-lora
```

重新训练：

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

测试 adapter 是否加载并具备目标行为：

```bash
CYBERNH_LLM_CHAT=0 ./S1_Start_llm.sh

/Users/chongzhang/CyberNH-LLM/.venv/bin/python \
  runtime/fine_tuning/system_scenarios/evaluate_adapter.py
```

只做数据和 tokenizer dry-run：

```bash
runtime/fine_tuning/system_scenarios/run_lora_finetune.sh --dry-run
```

## 规则数据集

`rules/` 目录保存了规则资料的加工结果：

```text
rules/raw/                 # 原始 PDF
rules/extracted/           # 抽取后的文本和 pdfinfo
rules/structured/          # 结构化 rules.jsonl、metrics.jsonl、schema
rules/datasets/            # 训练种子数据和评估样例
rules/reports/             # 覆盖率和整理报告
rules/README.md            # 数据集详细说明
```

这些数据可以用于后续微调、RAG 或规则约束实验。

## 前端面板

前端代码在 `public/`：

- `index.html`：页面结构
- `styles.css`：界面样式
- `app.js`：WebSocket、状态渲染、国际化、控制面板逻辑

右上角语言切换只影响显示层，不修改后端仿真状态和导出数据。

## 数据导出

前端面板提供实验数据导出按钮，会下载：

- `cybernh-events.jsonl`
- `cybernh-metrics.csv`

这些接口由 `server.js` 提供。

## 常见问题

### 找不到 LLM 虚拟环境

如果看到：

```text
LLM virtualenv is missing
```

说明 `CYBERNH_LLM_DIR` 指向的目录中没有 `.venv`。确认外部 LLM 目录存在，或显式指定：

```bash
CYBERNH_LLM_DIR=/absolute/path/to/CyberNH-LLM ./S1_Start_llm.sh
```

### 找不到模型文件

如果看到：

```text
LLM model files are missing
```

确认模型目录中存在 `.safetensors` 或 `.bin` 文件：

```text
CyberNH-LLM/models/Qwen3-VL-2B-Instruct/
```

### 不想使用本地模型

可以直接连接远程 OpenAI-compatible endpoint：

```bash
CYBERNH_START_LLM=0 \
CYBERNH_LLM_BASE_URL=http://your-llm-host:8000/v1 \
CYBERNH_LLM_API_KEY=your-key \
./01_run_sim.sh
```

### LLM 返回非法 JSON

Worker-Agent 决策要求结构化 JSON。项目会尝试一次修复请求；如果仍然失败，会记录 LLM 输入、输出和错误原因，便于在 `L2_listen_llm.sh` 中排查。

## 开发检查

```bash
npm run check
bash -n 01_run_sim.sh S1_Start_llm.sh L1_listen_queues.sh L2_listen_llm.sh
```

## Git 说明

仓库地址：

```text
git@github.com:franz-chang/CyberNH.git
```

不会进入 Git 的内容包括：

- `node_modules/`
- `runtime/logs/`
- `.env`
- `.venv/`
- Python `__pycache__/`
- 外部 `CyberNH-LLM/`
