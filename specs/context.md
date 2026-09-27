# Context —— 上下文治理（估算 / compact / trim）

一句话：轮前保证历史不超预算的双档治理——能摘要就摘要（compact），摘要失败就裁旧
（trim）；任何失败都不许破坏会话。权威出处：`impls/typescript/src/core/compact.ts`、
`impls/typescript/src/core/trim.ts`（触发点 `impls/typescript/src/core/turn.ts`）。

状态：正文 v1（2026-09-27）。基于五版源码静态比对 + 单测与冒烟验证；
两处五版分歧已按写作约定 1 裁决并修复（见"分歧裁决"）。

## 本质约束

1. 上下文有限且昂贵，会话历史只增不减，超限前必须治理——治理是请求能发出的前提。
2. 治理不许丢失"当前任务背景"：摘要保底（compact），最近原文保真（尾部 4 条），
   两者都不可得才丢历史细节（trim 只丢旧工具输出）。
3. 历史是唯一事实源：治理失败/中止时历史必须原封不动——compact 永不破坏会话。
4. 估算是折中不是精确值：3 字符 ≈ 1 token，不引分词器依赖；所有预算决策共用同一估算。

## 语言中立规则

- **R1 估算**：每条消息计 `content 字符数 + 8`，每个 tool_call 另计 `name+arguments 字符数 + 8`，
  总和除 3 向上取整；作用于全部消息（含 system）。全局唯一实现，compact 的前后估算
  与触发检查必须同款。
- **R2 触发**：轮前（user 消息入列前）`估算 > context_limit × 0.8`（严格大于）触发治理；
  `context_limit` 默认 100_000，环境变量 `<PREFIX>_CONTEXT_LIMIT` 覆盖。
- **R3 双档顺序**：先 compact；compact 抛错退 trim，trim 的 limit 是 100% context_limit（非 80%）。
- **R4 compact 准入**：消息数 ≤ 5 直接失败（"对话太短"），历史不动。
- **R5 compact 保留**：转写取 slice(1)（跳过 system）送摘要模型；尾部起点从 `max(1, len−4)`
  向后扫到最近 user 消息（配对安全：tool 不悬空），找不到 user 则不保留尾巴；
  摘要为 user 角色、固定包装文案；成功才以 `splice(1, tailStart−1, 摘要)` 替换历史；
  `savedTokens = max(0, before − after)`。
- **R6 compact 失败语义**：太短 / provider 错 / 空摘要 / 中止——历史原封不动；
  中止按各平台语义上抛（同步版以超时代替中止）。
- **R7 trim 规则**：候选 = 全部 tool 消息去掉最近 12 条；最旧优先、估算达标即停；
  只把 content 替换为固定占位文本，消息结构不动；空 content 或已是占位的跳过
  （幂等；空串无物可省，替换只会增加预算）。
- **R8 事件**：compact 成功发 `compact(savedTokens)`；trim 实裁 >0 才发 `trimmed(count)`。
- **R9 手动 /compact 命令**：复用同一 compact 实现；成功/失败各打固定文案，错误不上抛。

### 允许偏差（不收敛，登记在案）

| 偏差 | 版本 | 理由 |
| --- | --- | --- |
| 字符计数取 UTF-16 code unit 或 Unicode code point | ts/cs 前者，py/go/rs 后者 | 3:1 本身是粗估折中，精度差不影响预算决策结构 |
| 空白摘要（trim 后为空）也算失败 | rs | 加严，方向与 R6 一致 |
| 治理期间用户中止不退 trim | py | 平台真取消差异（KeyboardInterrupt 穿透），对照笔记已登记 |
| 空串 content 的转写行渲染 | py/go 渲染 `(tool_calls: N 个)`，ts/rs/cs 渲染 `role: ` | 只影响摘要输入文本，非行为契约 |

## 边界与依赖方向

- trim/compact 是 core 保留件，不开放插件替换（notes 2026-09-17：trim 属内核）。
- 依赖方向：core → kernel/types（消息词汇表）单向；compact 的摘要请求经 app.provider
  注入，core 不 import providers；估算函数单一出处（trim 导出、compact 复用）——
  禁止第二份估算实现。
- turn 是唯一触发者与事件生产者；治理发生在 user 消息入列之前。

## 五版落点

| 版本 | 触发点 | 估算 / compact / trim | 环境变量 |
| --- | --- | --- | --- |
| tcode | `src/core/turn.ts:25` | `src/core/trim.ts`、`src/core/compact.ts` | `TCODE_CONTEXT_LIMIT` |
| pcode | `pcode/core/turn.py:45` | `pcode/core/trim.py`、`pcode/core/compact.py` | `PCODE_CONTEXT_LIMIT` |
| gcode | `internal/core/turn.go:35` | `internal/core/trim.go`、`compact.go` | `GCODE_CONTEXT_LIMIT` |
| rcode | `src/core/turn.rs:35` | `src/core/trim.rs`、`compact.rs` | `RCODE_CONTEXT_LIMIT` |
| ccode | `core/Turn.cs:30` | `core/Trim.cs`、`Compact.cs` | `CCODE_CONTEXT_LIMIT` |

## 分歧裁决（2026-09-27，写作约定 1：要么改代码要么改规格）

1. **compact 私有估算（仅 tcode）**：tcode 的 compact 带一份不计 tool_call name 的私有估算，
   与自身注释（"与 trim 同款"）及四兄弟（全部复用 trim 估算）矛盾 → 判定 tcode 漂移 bug。
   修复：删私有估算，`compact.ts` 改 import trim 的 `estimateTokens`，四兄弟无需改动。
   回归锁：`test/compact.test.ts` "savedTokens 按全局唯一估算口径计"
   （独立手算字面量 102；修前实际 2，红→绿）。
2. **trim 空串替换（go/rust）**：替换空 tool content 只会增加 token（占位比空串长），
   违背"省预算"本质 → 判定 tcode/py/cs 侧为本质。修复：`trim.go`、`trim.rs` 各加空串守卫，
   五版行为归一。回归锁：五版 trim 单测各加"空内容工具输出不裁"（go/rust 修前 19 条红）。

## 反例清单（对抗式审查）

- 价值集中在长 tool_call name 的会话 → 触发与 savedTokens 必须同口径（裁决 1 的回归锁）。
- 消息数恰为 5 → compact 拒绝（R4 边界含 5）。
- 尾部 4 条全无 user 消息 → 不保留尾巴，全部并入摘要（R5 边界）。
- 摘要返回空串 → compact 失败 → 退 trim（R6→R3）。
- compact 中止/超时 → 历史原封不动；py 中止不退 trim（允许偏差）。
- 已 trim 的会话再次 trim → 0 条（幂等）。
- 候选区里的空 content tool 消息 → 跳过不计数（裁决 2）。
- context_limit 调到极小 → 每轮触发治理；trim 到顶仍可能超限（占位比空串长）——
  治理每轮至多一轮 compact + 一轮 trim，不循环重试；只求尽力释放，不求必达预算。
- assistant(tool_calls) ↔ tool 配对：治理只动 tool 的 content 或做配对安全切片，
  任何情况不允许悬空 tool_call（五版 trim 单测均断言）。
- savedTokens 恒 ≥ 0（max 钳位）。

## 低置信区

- ccode 新增绿锁单测未运行：本机无 .NET SDK（dotnet 不在 PATH 与常见安装位置），
  `impls/csharp/tests/TrimTests.cs` 新 case 未编译执行；本次未改 csharp 源码，风险面 = 测试本身。
- 冒烟场景（A/B/C/D/F/H）不直接覆盖 token 口径与 trim 边界；行为断言靠五版单测，
  gcode 另有冒烟 G（/compact 记忆保持）覆盖 compact 主路径。
- rust 摘要 20s 超时（SUMMARY_TIMEOUT）是五版唯一显式超时常量，其余版本依赖平台中止；
  超时数值属平台差异，未入规格。
- 五版落点的行号为 2026-09-27 快照，会随代码漂移。

## 验证记录（2026-09-27）

- 单测：tcode 47/47（`npm test`，`tsc --noEmit` 干净）、pcode 51/51、
  gcode `internal/core` ok、rcode 50/50；ccode 未跑（缺 .NET SDK，见低置信区）。
- 冒烟：tcode exit=0 七场景全过；pcode A/B/C/D/F/H 全过；gcode smoke ok；rcode 7/7；
  ccode 未跑。
