# IDEA-Agent

`IDEA-Agent` 是一个面向论文的 Stage 1 `Article-KG` 编译器。它会把一篇学术或技术文章转换为一个可追溯的知识图谱，中间每个知识单元都绑定原文 `evidence span`。

当前实现的是 MVP 闭环：

- 文档解析
- evidence span 切分
- 章节角色识别
- 语义归一化
- 双视图知识抽取
- KU 向量化
- 类型感知聚类
- 图谱构建与输出

项目位置：

- 服务器目录：`/home/staff_xiaobo_jin/IDEA-Agent`
- 虚拟环境：`/home/staff_xiaobo_jin/IDEA-Agent/idea`

## 目录说明

项目的常用目录如下：

```text
IDEA-Agent/
├── config.yaml
├── input/
├── outputs/
├── run_scigraph_llm.sh
├── examples/
├── idea_agent/
└── scripts/
```

其中：

- `config.yaml`：LLM 与 pipeline 配置
- `input/`：放待处理的论文 PDF
- `outputs/`：放抽取结果
- `run_scigraph_llm.sh`：固定处理 `input/SciGraph-LLM.pdf` 的一键脚本
- `idea_agent/`：核心代码

## 第一次使用

进入项目目录：

```bash
cd /home/staff_xiaobo_jin/IDEA-Agent
```

如果虚拟环境还没建好，运行：

```bash
bash scripts/bootstrap_env.sh
```

然后激活环境：

```bash
source idea/bin/activate
```

## 配置文件

项目默认从根目录下的 `config.yaml` 读取配置：

`/home/staff_xiaobo_jin/IDEA-Agent/config.yaml`

当前配置格式：

```yaml
llm:
  provider: deepseek
  api_key: "你的 key"
  base_url: "https://api.deepseek.com/v1"
  model: "deepseek-chat"
  timeout: 60

pipeline:
  similarity_threshold: 0.82
  embedding_dimensions: 256
```

你只需要把：

```yaml
api_key: "你的 key"
```

替换成真实的 DeepSeek API key。

如果 `api_key` 还是占位符，系统会自动退回规则模式，不会调用 LLM。

## 输入文件准备

建议先创建输入目录：

```bash
mkdir -p /home/staff_xiaobo_jin/IDEA-Agent/input
```

然后把论文上传到这里，例如：

`/home/staff_xiaobo_jin/IDEA-Agent/input/SciGraph-LLM.pdf`

## 运行方式

默认编译流程使用 `lazy` evidence 模式：先按章节合并为较大的 processing chunks，再在知识单元抽取完成后，只为被引用的句子生成细粒度 `EvidenceSpan`。这能显著减少 LLM 调用次数，同时保留证据追溯。

可选模式：

- `--span-mode lazy`：默认模式，chunk-first 抽取，延迟生成句子级 evidence
- `--span-mode chunked`：使用 chunk 作为 evidence，速度快但证据较粗
- `--span-mode paragraph`：旧流程，逐 paragraph span 处理

`lazy` 模式的证据匹配默认使用 `--evidence-backend auto`。如果环境中安装了 `torch` 且 CUDA 可用，会用 GPU 批量匹配 KU 与候选句子；否则自动退回词法匹配。

### 方式 1：直接运行固定脚本

如果输入文件是：

`/home/staff_xiaobo_jin/IDEA-Agent/input/SciGraph-LLM.pdf`

那么直接运行：

```bash
cd /home/staff_xiaobo_jin/IDEA-Agent
./run_scigraph_llm.sh
```

输出会写到：

`/home/staff_xiaobo_jin/IDEA-Agent/outputs/SciGraph-LLM`

### 方式 2：手动运行命令

```bash
cd /home/staff_xiaobo_jin/IDEA-Agent
source idea/bin/activate
idea-agent compile input/SciGraph-LLM.pdf \
  --doc-id SciGraph-LLM \
  --output outputs/SciGraph-LLM \
  --config config.yaml
```

### 方式 3：处理其他 PDF

例如你上传了：

`/home/staff_xiaobo_jin/IDEA-Agent/input/paper_001.pdf`

可以运行：

```bash
cd /home/staff_xiaobo_jin/IDEA-Agent
source idea/bin/activate
idea-agent compile input/paper_001.pdf \
  --doc-id paper_001 \
  --output outputs/paper_001 \
  --config config.yaml
```

### 方式 4：禁用 LLM，仅跑规则闭环

```bash
cd /home/staff_xiaobo_jin/IDEA-Agent
source idea/bin/activate
idea-agent compile input/paper_001.pdf \
  --doc-id paper_001 \
  --output outputs/paper_001 \
  --config config.yaml \
  --no-llm
```

## 输出文件说明

每次运行会在指定输出目录下生成：

- `document.json`：文档与章节信息
- `spans.jsonl`：evidence span 列表
- `normalized_views.jsonl`：归一化语义视图
- `knowledge_units.jsonl`：抽取出的知识单元
- `ku_embeddings.jsonl`：KU 向量
- `clusters.json`：类型感知聚类结果
- `graph.json`：最终知识图谱
- `pipeline_report.json`：运行摘要

其中最常看的通常是：

- `graph.json`
- `knowledge_units.jsonl`
- `spans.jsonl`
- `pipeline_report.json`

## 一个完整示例

```bash
cd /home/staff_xiaobo_jin/IDEA-Agent
source idea/bin/activate
mkdir -p input outputs
idea-agent compile examples/sample_article.md \
  --doc-id sample \
  --output outputs/sample \
  --config config.yaml
```

## 目前是否使用预训练模型

当前默认实现里：

- PDF 解析使用 `PyMuPDF`
- 章节角色识别、规则归一化、规则抽取使用规则逻辑
- 向量化使用确定性的 `hash embedding`
- 聚类使用基于相似度阈值的类型内聚类

所以：

- 没填 DeepSeek key 时：不使用预训练模型
- 填入 DeepSeek key 后：会通过 API 调用外部大模型参与语义归一化和知识抽取

## 常见问题

### 1. 运行时报找不到输入文件

先检查输入文件是否真的在：

```bash
ls -l /home/staff_xiaobo_jin/IDEA-Agent/input
```

### 2. 运行时没有调用 LLM

先检查：

```bash
sed -n '1,20p' /home/staff_xiaobo_jin/IDEA-Agent/config.yaml
```

确认 `api_key` 已经替换成真实 key，而不是：

```yaml
api_key: "你的 key"
```

### 3. 想看一次运行有没有成功

可以看输出目录里的：

```bash
ls -l outputs/SciGraph-LLM
cat outputs/SciGraph-LLM/pipeline_report.json
```

## 备注

- 这个项目已经按公共服务器环境做了隔离，运行依赖都在 `idea` 虚拟环境里。
- 当前服务器磁盘空间比较紧，后续如果批量处理很多论文，建议定期清理 `outputs/`。
