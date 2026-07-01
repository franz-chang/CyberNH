# 基于 Qwen3-VL SAE 的 `unsafe_mean - safe_mean` Feature Ranking 设计文档

## 1. 目标

本文档描述如何基于当前 `SAE_LENS` 项目的分析结果，在 `layer0`、`layer4`、`layer5` 三个层上对 `safe` 与 `unsafe` prompt 的 SAE feature 做排序分析，核心指标为：

```text
unsafe_mean - safe_mean
```

目标不是直接做分类器，而是找出：

- 哪些 SAE feature 在 `unsafe` prompt 上显著更高
- 哪些 feature 在 `safe` prompt 上更高
- 哪些 feature 值得继续做 token-level inspection 或后续 steering

## 2. 为什么选 `layer0 / layer4 / layer5`

根据现有实验结果：

- `layer0`  的 `safety` 对照有最低 SAE cosine，说明方向分离最明显
- `layer4`  和 `layer5` 仍然保持可解释的分离
- 中后层很多层虽然 `L2` 很大，但 `cosine` 接近 1，更像幅度变化，不适合作为第一批安全 feature 候选层

因此，第一版 feature ranking 应优先做这三层。

## 3. 分析对象

分析对象来自现有脚本中的 `safety` prompt 对照组：

- `safe`
- `unsafe`

每个 prompt 在 Qwen3-VL 文本模型某层会产生一段 hidden states；当前项目里通常取每个 prompt 最后若干个 token 位置，例如最后 `16` 个 token 位置。

随后使用对应层的 Qwen Scope SAE，将 hidden states 编码为 SAE feature activations。

## 4. 输入

需要的输入如下：

1. Qwen3-VL 模型
   - `models/Qwen3-VL-8B-Instruct`

2. Qwen Scope SAE 权重
   - `models/SAE-Res-Qwen3-8B-Base-W64K-L0_50/layer0.sae.pt`
   - `models/SAE-Res-Qwen3-8B-Base-W64K-L0_50/layer4.sae.pt`
   - `models/SAE-Res-Qwen3-8B-Base-W64K-L0_50/layer5.sae.pt`

3. safety prompt 集
   - `safe` prompts
   - `unsafe` prompts

4. 运行参数
   - `max_length`
   - `max_positions_per_prompt`
   - `encode_batch_size`
   - `model_device`
   - `sae_device`

## 5. 输出

建议输出两类文件。

### 5.1 机器可读结果

每层一个 JSON 文件，例如：

- `runs/.../layer0_feature_ranking.json`
- `runs/.../layer4_feature_ranking.json`
- `runs/.../layer5_feature_ranking.json`

每条记录至少包含：

- `feature_id`
- `unsafe_mean`
- `safe_mean`
- `delta = unsafe_mean - safe_mean`
- `unsafe_std`
- `safe_std`
- `effect_size`
- `unsafe_nonzero_rate`
- `safe_nonzero_rate`
- `nonzero_rate_delta`
- `rank_by_delta`

### 5.2 人类可读报告

一个 Markdown 汇总报告，例如：

- `runs/.../unsafe_feature_ranking_report.md`

报告中应包含：

- 每层 top unsafe-biased features
- 每层 top safe-biased features
- 候选 feature 的筛选建议
- 后续 token-level inspection 的优先级

## 6. 核心思路

对每一层分别做以下步骤：

1. 取 `safe` prompts，抽取该层 hidden states
2. 取 `unsafe` prompts，抽取该层 hidden states
3. 用该层对应 SAE 将 hidden states 编码成 feature activations
4. 将每组所有 token 位置上的 feature activation 拼接成一个二维张量
5. 按 feature 维度计算组内均值
6. 计算：

```text
delta = unsafe_mean - safe_mean
```

7. 按 `delta` 从大到小排序，得到 unsafe-biased feature ranking
8. 按 `delta` 从小到大排序，得到 safe-biased feature ranking

## 7. 张量定义

设某层 SAE 编码后的特征张量为：

```text
features_safe   : [N_safe_tokens, d_sae]
features_unsafe : [N_unsafe_tokens, d_sae]
```

其中：

- `N_safe_tokens` 是所有 `safe` prompt 被保留的 token 位置总数
- `N_unsafe_tokens` 是所有 `unsafe` prompt 被保留的 token 位置总数
- `d_sae` 是 SAE feature 维度

对每个 feature `j`：

```text
safe_mean[j]   = mean(features_safe[:, j])
unsafe_mean[j] = mean(features_unsafe[:, j])
delta[j]       = unsafe_mean[j] - safe_mean[j]
```

## 8. 建议同时计算的辅助指标

只看均值差会有点单薄，建议一并算下面几个指标。

### 8.1 非零激活率

由于 SAE feature 通常是稀疏的，非零率很重要：

```text
safe_nonzero_rate[j]   = mean(features_safe[:, j] > 0)
unsafe_nonzero_rate[j] = mean(features_unsafe[:, j] > 0)
nonzero_rate_delta[j]  = unsafe_nonzero_rate[j] - safe_nonzero_rate[j]
```

这能帮助区分：

- 是更多 token 激活了该 feature
- 还是激活 token 数差不多，但幅度更强

### 8.2 标准差

```text
safe_std[j]
unsafe_std[j]
```

标准差可以帮助识别是否被少数极端 token 拉高均值。

### 8.3 效应量

建议计算一个简化版 effect size，例如：

```text
effect_size[j] = (unsafe_mean[j] - safe_mean[j]) / (pooled_std[j] + eps)
```

其中：

```text
pooled_std[j] = sqrt((safe_std[j]^2 + unsafe_std[j]^2) / 2)
```

这比单纯看 `delta` 更稳，适合筛选稳定候选 feature。

## 9. 推荐排序策略

建议至少保留三种排序视角。

### 9.1 主排序

按 `delta = unsafe_mean - safe_mean` 降序排序。

用途：

- 直接找 `unsafe` 更高的特征

### 9.2 稳定性排序

按 `effect_size` 降序排序。

用途：

- 排除“均值差大但波动也很大”的 feature

### 9.3 稀疏触发排序

按 `nonzero_rate_delta` 降序排序。

用途：

- 找“unsafe 更容易触发”的特征

## 10. 候选 feature 过滤规则

为了避免被噪声 feature 干扰，建议加入最小过滤条件。

示例规则：

- `unsafe_nonzero_rate >= 0.01` 或 `safe_nonzero_rate >= 0.01`
- `abs(delta) >= min_delta`
- `effect_size >= min_effect_size` 仅用于 unsafe-biased 候选

第一版可以先不过滤太严，保留每层：

- top 50 unsafe-biased features
- top 50 safe-biased features

然后再人工查看前 20。

## 11. 与当前项目代码的衔接方式

最适合复用的现有逻辑在：

- `qwen3vl_sae_safety_contrast.py`
- `qwen3vl_sae_layer_sweep.py`

建议不要从零写，而是复用这些已有组件：

- `format_chat`
- `choose_device`
- `load_qwen_scope_sae`
- `encode_in_batches`
- prompt 列表 `CONTRASTS["safety"]`
- Qwen3-VL 某层激活抓取逻辑

### 11.1 新脚本建议

建议新增脚本，例如：

```text
qwen3vl_sae_feature_ranking.py
```

其职责是：

- 接收 `--layers 0 4 5`
- 对每层分别抓取 `safe/unsafe` hidden states
- 编码为 SAE features
- 计算 ranking 指标
- 输出 JSON 和 Markdown 报告

## 12. 处理流程设计

### Step 1. 加载模型与 processor

- 加载 `Qwen3-VL-8B-Instruct`
- 加载 `AutoProcessor`
- 确定 `model_device`

### Step 2. 逐层加载 SAE

对 `layer0/layer4/layer5`：

- 加载对应 `layer{n}.sae.pt`
- 将权重转换为 `SAE` 对象
- 放到 `sae_device`

### Step 3. 采集 safe/unsafe 激活

对每个 prompt：

- 应用 chat template
- 前向 through Qwen3-VL 文本模型
- 用 hook 抓取指定层输出
- 根据 attention mask 去掉 padding
- 保留最后 `max_positions_per_prompt` 个 token 位置

得到：

```text
safe_acts   : [N_safe_tokens, hidden_size]
unsafe_acts : [N_unsafe_tokens, hidden_size]
```

### Step 4. 编码到 SAE feature 空间

用该层 SAE 分别编码：

```text
safe_features   = sae.encode(safe_acts)
unsafe_features = sae.encode(unsafe_acts)
```

### Step 5. 计算统计量

对每个 feature 维度计算：

- `safe_mean`
- `unsafe_mean`
- `delta`
- `safe_std`
- `unsafe_std`
- `effect_size`
- `safe_nonzero_rate`
- `unsafe_nonzero_rate`
- `nonzero_rate_delta`

### Step 6. 生成排序结果

输出：

- top unsafe-biased features
- top safe-biased features
- 可选的 top stable unsafe-biased features

### Step 7. 写报告

Markdown 报告里建议按层展示：

- `Top 20 unsafe-biased features`
- `Top 20 safe-biased features`
- `Top 10 by effect size`
- 简短观察结论

## 13. 报告示例结构

```md
# Unsafe Feature Ranking Report

## Layer 0

### Top Unsafe-Biased Features
| rank | feature | unsafe_mean | safe_mean | delta | effect_size | unsafe_nonzero_rate | safe_nonzero_rate |
|---:|---:|---:|---:|---:|---:|---:|---:|

### Top Safe-Biased Features
...

### Notes
- layer0 在方向分离上最强，优先进入 token-level inspection。

## Layer 4
...

## Layer 5
...

## Cross-Layer Summary
- 哪些 feature 候选最稳定
- 哪些层最值得继续做解释
```

## 14. 结果应该怎么解读

如果某个 feature 同时满足：

- `delta` 大
- `effect_size` 大
- `unsafe_nonzero_rate` 明显高于 `safe_nonzero_rate`

那么它是较强的 `unsafe` 候选 feature。

如果某个 feature：

- `delta` 大，但 `unsafe_std` 也很大
- 非零率很低

那它可能只是被少数 token 拉高，不应直接当成稳定安全特征。

如果某个 feature 在 `layer0/layer4/layer5` 中重复出现类似趋势，就更值得优先分析。

## 15. 后续动作建议

feature ranking 做完后，建议按下面顺序继续。

1. 对每层前 10 到 20 个 unsafe-biased feature 做 token-level inspection
2. 记录这些 feature 在哪些 prompt、哪些 token 上最强
3. 区分它们到底对应：
   - 明确的危险行为词
   - 指令语气
   - 代码/安全术语
   - 格式噪声
4. 再决定是否做 steering 或 probe

## 16. 风险与注意事项

### 16.1 样本量小

当前 prompt 数量不大，因此 ranking 更适合做候选发现，不适合做强结论。

### 16.2 Token 位置截取会影响结果

只取最后 `16` 个 token 位置是一个分析选择，不同截取策略可能改变 feature 排名。

### 16.3 均值差不等于语义因果

`unsafe_mean - safe_mean` 只能说明相关性，不能直接说明某个 feature 导致了不安全行为。

### 16.4 层间 feature 不可直接对齐

`layer0` 的 feature `1234` 和 `layer5` 的 feature `1234` 不是同一个语义对象，跨层只能比较趋势，不能直接比较编号。

## 17. 实现建议

第一版实现建议尽量简单：

- 先只支持 `contrast=safety`
- 先只支持 `layers=0,4,5`
- 先输出 JSON 和 Markdown
- 不在第一版里加入可视化

等第一版结果稳定后，再扩展：

- `story vs code_logs`
- token-level top activation 导出
- feature 共现分析
- 小型线性 probe

## 18. 验收标准

完成后应满足：

1. 能对 `layer0/layer4/layer5` 分别输出 feature ranking
2. 每层都能列出 top unsafe-biased 与 safe-biased features
3. 结果中包含均值差、非零率和 effect size
4. 报告能明确指出下一步最值得做 token-level inspection 的 feature

---

如果进入实现阶段，推荐下一步直接落地一个脚本：

```bash
python qwen3vl_sae_feature_ranking.py \
  --contrast safety \
  --layers 0 4 5 \
  --model-device cuda \
  --sae-device cuda \
  --max-positions-per-prompt 16
```
