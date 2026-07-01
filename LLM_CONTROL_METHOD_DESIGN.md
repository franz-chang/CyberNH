# 基于激活与 SAE 特征的 LLM 控制方法设计方案



## 1. 文档目标

本文档整理一条从“发现模型内部规律”走向“实现 LLM 控制方法”的完整设计路线。这里的“控制”指的是：

- 当模型内部出现不安全相关表征时，识别这些信号
- 在生成过程中对这些信号进行检测、门控或干预
- 尽量在保留正常能力的前提下，降低不安全输出概率

这份方案特别适用于当前已经具备如下基础的场景：

- 已经完成 safe / unsafe prompt 对照实验

- 已经做过 layer sweep

- 已经发现 `layer0 / layer4 / layer5` 更值得做安全分析

- 已经准备基于 `unsafe_mean - safe_mean` 做 feature ranking



## 2. 总体思路

整个方法不建议一开始就做重训练，而应采用“先观察、再检测、后干预”的渐进路线：

1. 先定义要控制的目标
2. 找到与该目标相关的内部信号
3. 把信号做成一个可计算的控制器
4. 设计干预动作
5. 评估干预是否真的有效，以及副作用是否可接受

这条路线的核心优势是：每一步都能验证，且能最大程度避免过早解释或过度干预。



## 3. 控制目标定义

在实现控制之前，必须先明确“我们要控制什么”。常见控制目标包括：

- 控制输出内容：降低 unsafe 回答概率
- 控制输出风格：让回答更保守、更正式或更稳定
- 控制内部表征：抑制某些 feature，增强某些 feature
- 控制策略切换：在高风险状态下进入安全模式

结合当前项目，建议将第一版目标定义为：

```text
当模型内部出现 unsafe 相关表征时，检测这些表征，并对其进行轻量干预，从而降低不安全输出概率。
```

这是一个合适的起点，因为它与当前已有的 SAE 和激活分析结果可以直接衔接。



## 4. 前置步骤

在真正实现控制器之前，需要完成一组前置分析步骤。这些步骤不是可选项，而是整个方法成立的基础。

### 4.1 构建 safe / unsafe 对照数据

首先准备一组质量较高的 prompt 对照集：

- `safe` prompts
- `unsafe` prompts

要求：

- 主题尽量贴近，避免把领域差异混成安全差异
- 长度尽量接近，避免纯长度效应
- 可逐步增加多模板版本，为后续鲁棒性分析准备材料

### 4.2 抓取模型内部激活

对目标模型的指定层抓取 hidden states，建议优先从文本主干层开始。

对每个 prompt：

- 做标准化模板包装
- 前向 through 模型
- 采集目标层 hidden states
- 根据 attention mask 去掉 padding
- 保留固定位置范围，例如最后若干个 token 位置

输出形式通常为：

```text
activations_safe   : [N_safe_tokens, hidden_size]
activations_unsafe : [N_unsafe_tokens, hidden_size]
```

### 4.3 做 layer sweep

不要直接假定某一层最重要，而是先对多个层重复 safe / unsafe 对照分析。

建议关注的指标：

- raw activation centroid cosine
- raw activation centroid L2 distance
- SAE feature centroid cosine
- SAE feature centroid L2 distance
- top-feature Jaccard

这一步的目的，是确定：

- 差异主要出现在哪些层
- 这些差异更像方向分离还是幅度变化
- 哪些层真正具有后续解释价值

### 4.4 选出候选控制层

根据现有结果，当前最值得优先考虑的层是：

- `layer0`
- `layer4`
- `layer5`

原因是：

- 它们在 `safety` 对照里表现出更清晰的可解释分离
- 许多中后层虽然 `L2` 大，但 `cosine` 高，更像幅度变化

### 4.5 做 feature ranking

在候选层上，把 hidden states 编码到 SAE feature 空间，再对 `safe` 和 `unsafe` 组做特征排序。

核心指标：

```text
delta = unsafe_mean - safe_mean
```

对每个 feature 进一步计算：

- `unsafe_mean`
- `safe_mean`
- `delta`
- `unsafe_std`
- `safe_std`
- `unsafe_nonzero_rate`
- `safe_nonzero_rate`
- `effect_size`

这一阶段的目标是找出：

- 哪些 feature 是 `unsafe-biased`
- 哪些 feature 是 `safe-biased`
- 哪些 feature 更可能是稳定的安全相关特征，而不是偶然噪声

### 4.6 做 token-level inspection

feature ranking 之后，必须检查 top feature 到底在响应什么。

需要回答的问题包括：

- 它是否对应危险动作词，例如攻击、绕过、窃取等
- 它是否只是响应命令式语气
- 它是否只是响应代码、日志、格式符号等风格特征

这一步是区分“安全语义特征”和“风格噪声特征”的关键。

### 4.7 做 negative control 和模板鲁棒性检查

为了避免把风格误判为安全信号，建议加入：

- 高风险语气但无真实危害的 prompt
- 技术性强但明确安全的 prompt
- 同一 unsafe 意图的多模板改写
- 中英混合或长上下文包裹版本

如果某些 feature 在这些变化下仍稳定出现，才更适合作为控制目标。



## 5. 可控内部信号的形式

在完成前置分析后，可以把可控信号分成两类。

### 5.1 方向信号

在 hidden state 空间中定义：

```text
unsafe_direction = mean_unsafe - mean_safe
```

它表示 unsafe 样本相对于 safe 样本的平均偏移方向。

适合用于：

- direction steering
- early-layer residual correction

### 5.2 feature 信号

在 SAE feature 空间中找到：

- top unsafe-biased features
- top safe-biased features

适合用于：

- sparse safety score
- feature suppression
- feature-triggered gate



## 6. 控制器设计

控制器的作用，是把“观察到的内部信号”变成一个可运行、可触发的控制模块。

建议按从简单到复杂的顺序设计。

### 6.1 分数型控制器

定义一个风险分数，例如：

```text
unsafe_score = sum(w_i * feature_i)
```

或者：

```text
unsafe_score = probe(hidden_state)
```

其中 `w_i` 可以来自：

- `unsafe_mean - safe_mean`
- effect size
- 线性 probe 的权重

作用：

- 衡量当前内部状态有多接近 unsafe 表征

### 6.2 阈值型控制器

当：

```text
unsafe_score > threshold
```

时，触发控制动作。

优点：

- 易实现
- 解释清楚
- 适合第一版系统

### 6.3 连续型控制器

根据 `unsafe_score` 大小连续调节干预强度，例如：

```text
strength = alpha * unsafe_score
```

适合后续更细粒度控制，但第一版不必优先采用。



## 7. 干预方法设计

结合当前基础，干预方法可分为四级。

### 7.1 方法 A：输出层控制

这是最轻量的方法，不修改模型内部表示。

流程：

1. 计算 `unsafe_score`
2. 若分数过高，则：
   - 拒答
   - 切换到更保守模板
   - 做回答重写

优点：

- 工程实现简单
- 稳定
- 适合作为基线

缺点：

- 更像外部 guardrail，而非内部控制

### 7.2 方法 B：方向 steering

在目标层对 hidden state 做方向性修正：

```text
h' = h - alpha * unsafe_direction
```

这里：

- `h` 是原始 hidden state
- `unsafe_direction` 来自 safe / unsafe 样本均值差
- `alpha` 是干预强度

优点：

- 实现相对直接
- 与当前 layer-level 分析自然衔接

风险：

- 容易影响正常能力
- 对模板变化可能不够稳

### 7.3 方法 C：SAE feature suppression

在 SAE 空间中对特定 feature 做抑制。

流程：

1. 取目标层 hidden state
2. 用 SAE 编码为 feature activations
3. 对 top unsafe-biased features 做裁剪或缩放
4. decode 回 hidden state
5. 继续后续前向

示例形式：

```text
f'_j = beta_j * f_j
```

其中：

- 若 `j` 属于 top unsafe-biased features，则 `0 <= beta_j < 1`
- 否则 `beta_j = 1`

优点：

- 干预对象明确
- 粒度比 direction steering 更细
- 更适合做可解释控制研究

风险：

- 对 SAE 重构质量有依赖
- 实现比方向 steering 更复杂

### 7.4 方法 D：训练型轻量控制器

在更后期阶段，可训练一个小模块：

- linear probe
- controller MLP
- gating module
- adapter

输入是 hidden state 或 SAE features，输出是：

- 一个控制分数
- 一个门控向量
- 一个 residual correction

这一方向灵活性高，但第一版不建议优先采用。



## 8. 推荐的最小可行实现路线

如果目标是尽快做出一个可验证的控制原型，建议使用下面这条路线。

### 阶段 1：先做检测器

1. 在 `layer0 / layer4 / layer5` 做 feature ranking
2. 选出 top unsafe-biased features
3. 构造一个 `unsafe_score`
4. 验证该分数是否能区分 `safe / unsafe` prompt

目标：

- 先证明内部信号是“可用的”

### 阶段 2：再做轻干预

可先尝试两种最小干预方法：

- 方案 1：direction steering
- 方案 2：feature suppression

验证指标：

- unsafe 输出是否减少
- safe 输出是否仍然正常

### 阶段 3：加入条件触发机制

不是始终干预，而是当：

```text
unsafe_score > threshold
```

时才启动 steering 或 suppression。

这样更接近真正的控制系统，而不是简单静态修改。



## 9. 评估设计

控制方法不能只看“危险回答是否减少”，还必须看副作用。

建议至少从四个维度评估。

### 9.1 安全性

- unsafe 请求成功率是否下降
- 有害细节输出是否减少
- 拒答触发是否更及时

### 9.2 正常能力保留

- safe 请求回答质量是否下降
- 是否出现过度拒答
- 是否影响一般帮助性

### 9.3 鲁棒性

- 换 prompt 模板后是否仍有效
- 换语言后是否仍有效
- 换长度和上下文结构后是否仍有效

### 9.4 可解释性

- 被抑制的 feature 是否真与 unsafe 意图相关
- 干预前后哪些 token / feature 变化最大
- 干预是否集中作用在预期层和预期 feature 上



## 10. 方法对比建议

建议至少比较下面几组方案：

- 无控制
- 输出层 guardrail
- direction steering
- SAE feature suppression
- gate + steering
- gate + suppression

这样可以回答：

- 外部控制和内部控制谁更有效
- 精细特征干预和整体方向干预谁副作用更小
- 条件触发是否优于始终干预



## 11. 当前阶段最推荐的方法

如果只选择一条最值得优先落地的方法，我建议：

1. 先在 `layer0 / layer4 / layer5` 上做 `unsafe_mean - safe_mean` feature ranking
2. 对 top feature 做 token-level inspection
3. 构建一个基于 SAE features 的 `unsafe_score`
4. 先做 `feature-triggered suppression`
5. 再和 `direction steering` 做对比

原因是：

- 与当前已有发现衔接最直接
- 可解释性强
- 适合逐步扩展成完整控制框架



## 12. 风险与注意事项

### 12.1 风格混淆风险

当前已知 `style` 信号较强，因此必须警惕把风格相关 feature 误当成安全 feature。

### 12.2 层间不可直接对齐

不同层的 SAE feature 编号不能直接视为同一语义实体，只能做层内分析和跨层趋势比较。

### 12.3 均值差不等于因果控制点

一个 feature 在 `unsafe` 上更高，并不自动说明它就是“导致不安全输出”的因果节点。

### 12.4 干预可能损伤正常能力

尤其是 direction steering 和强 feature suppression，可能会影响模型对正常技术问题的理解和表达。



## 13. 实施顺序建议

推荐按以下顺序推进：

1. 完成 safe / unsafe 对照数据集整理

2. 完成 `layer0 / layer4 / layer5` feature ranking

3. 完成 token-level inspection

4. 完成 negative control 和模板鲁棒性分析

5. 构建 `unsafe_score`

6. 落地最小控制原型

7. 评估安全性与副作用

8. 迭代 gate、干预强度和 feature 集合



## 14. 建议思路

实现一种 LLM 控制方法，最稳妥的路线并不是直接训练一个大控制模块，而是：

- 先确认内部规律
- 再定位候选层
- 再找候选 feature
- 再构建控制分数
- 最后做条件化干预

对当前这条研究线来说，最自然的控制路径是：

```text
激活分析 -> layer sweep -> feature ranking -> token-level inspection
-> unsafe_score -> 条件触发干预 -> 效果与副作用评估
```

这条路线既能保持解释性，也足够贴近真实可实现的控制系统。
