# Conformance Normalization Policy（归一化边界 v1）

状态：设计冻结（2026-10-01），与 [conformance-schema.md](conformance-schema.md) 配套。
本文回答一个问题：**什么必须一致，什么允许差异。**

## 0. 三条元原则

1. **行为一致 > 输出一致**：比较对象是规范约束的行为语义，不是渲染文本。
2. **归一化必须锚定 specs**：每条允许差异（E 条目）必须指认允许偏差登记表或
   "规范未约束"的出处。**指认不出 = 不得归一**——把差异 normalize 掉以换取绿灯，
   是本体系的第一罪恶（假一致）。
3. **Fail closed**：diff 结果必须输出三元分类——**漂移 / 允许差异（引用 E 条目）/
   归一化伪影（本策略 bug）**。无法归入三元的，一律按**漂移**处理：宁可红灯误报，
   不可绿灯假阳。

## 1. 必须一致（N 条目）

| # | 内容 | 规范锚 |
| --- | --- | --- |
| N1 | 工具调用线格式语义：`name`、`arguments`、九工具名单与注册顺序 | tool-protocol R1/R5/R7 |
| N2 | 消息配对不变量：每个 tool_call 恰产生一条 role=tool 消息，任何出口不悬空 | agent-loop 本质约束 1 |
| N3 | 规范锁定文案**逐字**：Plan Mode 拒写全文、用户拒绝话术、断尾占位「（用户中止，未执行）」、未知工具模板（工具清单部分除外） | agent-loop R3/R6/R7、event R8 |
| N4 | canonical 事件顺序子集：治理事件 → turn_start → user → …（usage/text_delta/tool_call/tool_result）* → turn_end；每轮恰一个终态 | event R2/本质约束 3 |
| N5 | 错误**类别**：模型面五类别 + 进程面四等级（schema §2 分类学）逐位一致；类别内的原文措辞不比 | schema §2 |
| N6 | artifacts 终态字节：文件要么逐字节等于期望，要么 unchanged；"大致变了"不是结论 | 工具语义 |
| N7 | 退出码等级：0/1 及其语义映射 | exec 契约 |
| N8 | 请求到达序：provider 收到请求的顺序与剧本步进序一致（工具串行执行） | agent-loop R8 |

## 2. 允许差异（E 条目，逐条锚定）

| # | 允许差异 | 锚 |
| --- | --- | --- |
| E1 | 时间戳、毫秒数、usage 数值、各类 id（turn id / call id / uuid / 文件名随机后缀） | event/session 允许偏差表；规范未约束 |
| E2 | 事件字段命名与载体形态（savedTokens/saved_tokens/SavedTokens 等） | event 允许偏差表 |
| E3 | stdout 装饰文本：banner、提示符、渲染装饰、与契约无关的提示行——S3 通道只做包含/缺席断言 | 渲染非契约（event 本质约束 4） |
| E4 | 非锁定错误**原文**（e.message / str(e) / e.Message 之差）；锁定文案除外（见 N3） | agent-loop 允许偏差表 |
| E5 | SSE 流尾 EOF 半事件：丢弃 vs 冲刷 | provider 允许偏差表（两派并存） |
| E6 | 平台分档：轮中取消 ts/go/cs supported、py/rs unsupported（SC-005 臂 B 只登记不比对） | ADR-002 Non Goals、取消通道矩阵 |
| E7 | 协议编码差异：同一逻辑断言在 openai/anthropic 线格式下的字段名不同（input_schema vs parameters 等） | provider R2/R3——断言按 scenario 所选协议分形 |
| E8 | 白名单归一化深浅（py 真实路径解析 vs 其余词法归一）、py 300s 超时、rs 20s 摘要超时等**已登记的加严** | permission/context 允许偏差表——加严方向差异不构成漂移 |

## 3. 反例清单（过度归一化的样子——每条都违反具体 N 条目）

- **排序后比较** tool_calls / tool 结果（按名字排序再 diff）→ 违反 N8：串行顺序是契约，
  排序会把顺序漂移洗成绿灯。
- **截断/采样 stdout 后比较** → 违反 N3：锁定文案的漂移恰好可能藏在被截掉的差异里。
- **所有错误统一归为一类 `error`** → 违反 N5：tool_error_folded（可恢复）与 provider_fatal
  的类别之差正是 SC-003 要验证的行为。
- **锁定文案做"包含关键词"匹配**（如只查包含"Plan Mode"）→ 违反 N3：逐字锁定的文案退化成
  关键词，文案漂移从此不可见。
- **时间戳/id 先抹再比（把整条请求体 normalize 成空）** → 违反 N1：结构性断言依赖具体字段，
  全抹等于不比。
- **平台差异当漂移报（或反向：把真漂移登记成"平台差异"了事）** → 违反 E6 的边界：分档
  只适用于已登记条目；新差异必须先过裁决（specs 写作约定 1：要么改代码要么改规格），
  才能进 E 表。

## 4. diff 报告的输出契约

每个不一致点必须输出：`(通道, 场景断言, 五版实际值, 三元分类, 依据)`。其中：

- **漂移** → 开裁决：按写作约定 1 改代码或改 spec；
- **允许差异** → 必须已持有 E 条目号；新差异走裁决后**新增 E 条目**，不允许就地宽容；
- **归一化伪影** → 本策略或 runner 的 bug，修 policy/runner，不动 runtime。

## 5. 与 lessons 的接续

- L1（Build Freshness Invariant）：新鲜度门失败 = 基建错误，**不产生任何行为判定**——
  缺新鲜度的"绿灯"与"红灯"都无效。
- L2（Environment Premise Expiry）：适配器声明环境前提；前提不满足报基建错误并显式报警，
  不得静默跳过该 runtime（静默跳过 = 五分之×的验证面无声失踪）。
