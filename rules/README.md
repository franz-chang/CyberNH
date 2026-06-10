# Cyber-NH Rules Dataset

本目录保存从 `规则.pdf` 抽取、清洗、结构化后的 Cyber-NH 规则数据。它的目标不是只把 PDF 文本塞进模型，而是把规则变成可追溯、可校验、可扩展的数据资产，用于后续的 LLM 微调、规则检索、仿真运行时校验和指标评估。

## 数据来源

- 原始文件：[raw/规则.pdf](raw/规则.pdf)
- PDF 信息：[extracted/pdfinfo.txt](extracted/pdfinfo.txt)
- 抽取文本：[extracted/rules_text.txt](extracted/rules_text.txt)
- 清洗文本：[extracted/rules_text.md](extracted/rules_text.md)

当前 PDF 共 3 页，主要覆盖：

- 任务中断与抢占逻辑
- 老人护理等级与任务概率耦合
- 双人协作任务逻辑
- 隐性工作量建模
- 居民侧、护理员侧、系统侧量化指标

## 目录结构

```text
rules/
  raw/
    规则.pdf
  extracted/
    pdfinfo.txt
    rules_text.txt
    rules_text.md
  structured/
    rule_schema.json
    rules.jsonl
    metrics.jsonl
  datasets/
    train_seed.jsonl
    eval_cases.jsonl
  reports/
    coverage.md
```

## 文件级说明与数据格式

### `raw/规则.pdf`

原始规则文档快照。它是数据集的来源文件，主要用于人工追溯，不建议直接作为微调输入。

数据格式：

```text
PDF binary
```

理解方式：

- 它是最高层的原始证据。
- 后续所有结构化规则都应能通过 `source`、`section`、`page` 追溯回这个 PDF。
- 如果 PDF 内容更新，应重新抽取文本并同步更新结构化文件。

### `extracted/pdfinfo.txt`

PDF 元信息，由 `pdfinfo` 生成。

数据格式：

```text
Key: value
Key: value
...
```

示例字段：

```text
Pages:           3
Encrypted:       no
PDF version:     1.3
```

理解方式：

- 用于记录 PDF 页数、创建时间、加密状态、文件大小等。
- 它不是规则内容本身，只是数据来源的元数据。

### `extracted/rules_text.txt`

从 PDF 直接抽取出的原始文本，保留了 `pdftotext -layout` 的排版痕迹。

数据格式：

```text
plain text
```

理解方式：

- 这是从 PDF 到结构化数据之间的原始中间层。
- 适合排查“结构化数据是不是误读了 PDF”。
- 文本中可能包含分页符、缩进、换行和排版残留，不适合直接训练。

### `extracted/rules_text.md`

人工清洗后的 Markdown 版规则文本，按页码和小节组织。

数据格式：

```markdown
# Extracted Rules Text

## Page 1

### 6. Others

#### A. Task Interruption and Preemption Logic

...
```

理解方式：

- 这是最适合人阅读的抽取文本。
- 它把 PDF 里的规则按 `Page`、章节、小标题整理出来。
- 后续人工审校、规则补充、数据标注时，优先看这个文件。

### `structured/rule_schema.json`

规则对象、指标对象、微调种子样本的字段规范说明。

数据格式：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Cyber-NH Rule Data Asset",
  "rule_object": {},
  "metric_object": {},
  "fine_tune_seed_object": {}
}
```

理解方式：

- 这是数据集的“字段字典”。
- 它说明 `rules.jsonl`、`metrics.jsonl`、`train_seed.jsonl` 应有哪些字段。
- 当前它更偏说明性 schema，不是完整严格 validator。

### `structured/rules.jsonl`

结构化行为规则库。每一行是一条独立规则。

数据格式：

```text
JSON Lines
one JSON object per line
```

单行对象格式：

```json
{
  "rule_id": "R-CNH-006B2-001",
  "source": "rules/raw/规则.pdf",
  "section": "6.B2 Two-Person Assistance Coordination Logic",
  "page": 2,
  "category": "coordination",
  "actor": "worker_agent",
  "trigger": "heavy_task_assignment",
  "condition": "A heavy task requires two-person assistance, for example a transfer.",
  "action": "Require two caregivers to be present simultaneously before task execution can begin.",
  "constraints": [
    "Do not start service when only one required caregiver has arrived."
  ],
  "parameters": {
    "example_task": "transfer",
    "required_workers": 2
  },
  "priority": 100,
  "enforcement": "hard",
  "implementation_hint": "For two-person tasks, keep demand status assigned or coordination_waiting until arrivedWorkerIds length reaches requiredWorkers.",
  "test_cases": [
    {
      "input": {},
      "expected": {}
    }
  ]
}
```

理解方式：

- 一条 `rule_id` 对应一个可以被检索、引用、测试的规则单元。
- `category` 表示规则主题，如抢占、中断、双人协作、任务概率、隐性工作量。
- `actor` 表示规则适用于谁：系统、老人 agent、护理员 agent、指标管线等。
- `enforcement` 很重要：
  - `hard`：应由代码或规则校验器硬性保证，不能只靠 LLM。
  - `soft`：建模建议或概率范围，可由配置或采样策略实现。
  - `measurement`：指标记录要求。
- `implementation_hint` 是给工程实现看的，不是 PDF 原文。
- `test_cases` 是最小合规测试，用于后续自动化校验。

### `structured/metrics.jsonl`

结构化指标定义库。每一行是一条指标。

数据格式：

```text
JSON Lines
one JSON object per line
```

单行对象格式：

```json
{
  "metric_id": "M-CNH-007-001",
  "source": "rules/raw/规则.pdf",
  "section": "7 Quantifiable Output Metrics",
  "page": 3,
  "name": "Average waiting time",
  "category": "resident_side",
  "definition": "Mean time from call to caregiver arrival.",
  "unit": "minutes",
  "formula": "mean(first_caregiver_arrival_tick - demand_created_tick)",
  "aggregation_level": "scenario, shift, run",
  "event_fields_required": [
    "demand_id",
    "demand_created_tick",
    "first_caregiver_arrival_tick"
  ]
}
```

理解方式：

- `metric_id` 是稳定指标 ID，可在报告、代码和评测里引用。
- `category` 把指标分成居民侧、护理员侧、系统侧。
- `formula` 是建议计算方式。
- `event_fields_required` 说明仿真日志必须记录哪些字段才能计算该指标。
- 这个文件适合指导后续日志字段设计和实验报告统计。

### `datasets/train_seed.jsonl`

微调种子样本。每一行是一个 messages 格式的监督样本。

数据格式：

```text
JSON Lines
one fine-tuning seed example per line
```

单行对象格式：

```json
{
  "example_id": "FT-CNH-002",
  "rule_ids": ["R-CNH-006B2-001", "R-CNH-006B2-002"],
  "messages": [
    {
      "role": "system",
      "content": "You are a Cyber-NH Worker-Agent..."
    },
    {
      "role": "user",
      "content": "Worker-04 is idle..."
    },
    {
      "role": "assistant",
      "content": "{\"agent_id\":\"Worker-04\",\"action\":\"join_two_person_task\",...}"
    }
  ]
}
```

理解方式：

- 它是“高质量模板”，不是最终训练集。
- `messages` 使用 OpenAI chat fine-tuning 风格。
- `assistant.content` 是字符串形式的 JSON，不是嵌套 JSON 对象。这是为了适配聊天微调格式。
- `rule_ids` 标记该样本训练了哪些规则，便于追踪样本覆盖。
- 后续扩增训练集时，应围绕这些模板生成更多正例、反例、边界例和冲突例。

### `datasets/eval_cases.jsonl`

规则评测样例。每一行是一个确定性测试用例。

数据格式：

```text
JSON Lines
one evaluation case per line
```

单行对象格式：

```json
{
  "case_id": "EVAL-CNH-002",
  "rule_ids": ["R-CNH-006B2-001", "R-CNH-006B2-002"],
  "input": {
    "task_class": "heavy",
    "task_label": "transfer",
    "required_workers": 2,
    "arrived_worker_count": 1
  },
  "expected": {
    "service_can_start": false,
    "state": "coordination_waiting",
    "coordination_waiting_time_should_be_recorded": true
  }
}
```

理解方式：

- 它不是训练数据，而是测试数据。
- 可用于检查 LLM 输出、仿真状态或规则引擎是否符合规则。
- `input` 是测试场景。
- `expected` 是必须满足的结果或约束。
- 特别适合回归测试 `enforcement = hard` 的规则。

### `reports/coverage.md`

规则覆盖报告。

数据格式：

```markdown
# Rules Data Coverage Report

| PDF section | Covered by | Count |
| --- | --- | ---: |
...
```

理解方式：

- 说明 PDF 每个章节被哪些数据文件覆盖。
- 记录哪些内容是 PDF 明确规定，哪些是后续建模解释。
- 当新增规则或指标时，应同步更新这份报告。

## 使用建议

### 1. 规则检索

可以把 `structured/rules.jsonl` 切入向量库或普通关键词检索，让 LLM 在决策前检索相关规则。

推荐检索键：

- `category`
- `actor`
- `trigger`
- `condition`
- `action`
- `implementation_hint`

### 2. 微调

不要直接用 PDF 原文微调。建议流程：

```text
rules.jsonl + metrics.jsonl
  -> 扩增场景样本
  -> train.jsonl / validation.jsonl
  -> 微调 LLM
  -> eval_cases.jsonl 回归评测
```

`train_seed.jsonl` 当前是种子集，数量较少。真正微调前，应基于每条规则扩增正例、反例、边界例和冲突例。

### 3. 运行时校验

对于 `enforcement = hard` 的规则，不建议只靠 LLM 自觉遵守。应在仿真代码中做硬校验，例如：

- 双人任务必须两名护理员到齐才能开始
- 中断任务必须保存剩余时间或重新生成
- 协作等待状态必须记录等待时间

LLM 可以负责建议行动，但最终动作应经过规则校验器。

### 4. 指标统计

`metrics.jsonl` 里的 `event_fields_required` 可以用来反推仿真日志需要记录哪些字段。后续如果新增实验指标，应同步更新：

- `metrics.jsonl`
- `reports/coverage.md`
- 相关 `eval_cases.jsonl`

## 当前数据量

- 结构化规则：10 条
- 指标定义：11 条
- 微调种子样本：7 条
- 评测样例：7 条

## 维护约定

- 修改规则时，优先更新 `structured/rules.jsonl`，再更新训练样本。
- 修改指标时，优先更新 `structured/metrics.jsonl`。
- 每条规则和指标都必须保留 `source`、`section` 和 `page`，方便追溯。
- 不要把 `raw/规则.pdf` 当作唯一事实来源直接喂给模型；结构化文件才是后续工程使用的主数据。
- 新增规则时，优先使用稳定 ID，例如 `R-CNH-006B2-003`。
- 新增指标时，优先使用稳定 ID，例如 `M-CNH-007-010`。

## 下一步

建议下一步做两件事：

1. 基于 `train_seed.jsonl` 自动扩增训练集，覆盖更多房间、护理员状态、任务类型和冲突场景。
2. 写一个规则校验脚本，读取 `eval_cases.jsonl`，用于检查 LLM 输出或仿真状态是否符合硬规则。
