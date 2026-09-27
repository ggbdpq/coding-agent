# Agent Loop —— 工具往返循环（熔断 / 错误回流 / Plan Mode 拒写）

一句话：模型自主性的编排器——带工具请求 → 串行执行工具 → 结果回流传回，直到模型
收尾或 40 轮熔断强制总结。权威出处：`impls/typescript/src/core/agentloop.ts`。

状态：正文 v1（2026-09-27）。基于五版源码静态比对 + 单测验证；本主题五版行为语义
一致，无代码裁决，两处实现层防线差异登记为允许偏差（见对应节）。
主题边界：事件发射属 [event.md](event.md)；权限闸门内部属 [permission.md](permission.md)；
断尾修复与落盘归 turn 层，循环只负责异常原样上抛。

## 本质约束

1. 每个 tool_call 恰产生一条 role=tool 消息——消息配对合法性是循环不变量，
   任何出口（结果/错误/拒绝/拒写/未知工具）都必须落一条 tool 消息。
2. 模型自主性有硬上限（40 轮），但熔断不是失败——强制总结收尾，会话照常落盘。
3. 工具失败是模型可修的输入，不是进程错误——错误文本回流，让模型自行纠正。
4. 循环零策略零事件：安全策略经 check 回调、事件经四类回调上抛、装配归 turn——
   循环只做编排，不持全局状态、不插件化。

## 语言中立规则

- **R1 循环结构**：一轮 = 一次带 tools 的模型请求 → assistant 消息入列 →
  响应无 tool_calls 即正常终止（唯一正常出口）；否则串行执行全部 tool_calls，
  处理完续轮。单条消息可带多个 tool_calls，全部执行完才进下一轮。
- **R2 熔断**：`MAX_TOOL_ROUNDS = 40`，口径是带工具的模型请求次数（非工具调用
  个数）；循环耗尽后追加一次**不带工具 schema** 的请求强制总结，消息照常入列；
  不发特殊事件、不加"已达上限"话术。实际请求上限 40+1。
- **R3 工具执行五出口**（每个 tool_call 必居其一，各落一条 tool 消息）：
  执行结果；错误文本（`错误：{原因}`）；未知工具（`错误：未知工具 {name}。可用工具：{列表}`）；
  Plan Mode 拒写（R6）；用户拒绝（R7）。
- **R4 参数 JSON 非法**：静默降级为空参数，不在循环层报错——落下去让工具返回的
  错误文本纠正模型。
- **R5 provider 错误边界**：循环零处理零重试，原样上抛给 turn；重试只存在于
  providers 层（≤3 次指数退避、仅首字节前、取消绝不重试）。终态事件不归循环发。
- **R6 Plan Mode 拒写**：状态是 App 上默认 false 的布尔 ref（/plan 切换）；
  被拒集合 = `planMode && tool.needsPermission`（声明式，非工具名单）；判定位置在
  on_tool_call 回调、preview、白名单、权限闸门**四者之前**——不执行、不询问、
  不发 tool_call 事件、不算工具执行，只回统一拒写文本 + tool_result(ms=0)。拒写全文
  （五版逐字同文）：
  > 当前处于 Plan Mode（只读规划）：禁止执行写类操作。请继续只读探索，并输出一份分步计划；完成后告知用户用 /plan 切回普通模式执行。
- **R7 用户拒绝**：tool 消息固定话术「用户拒绝了本次操作。请询问用户怎么办，
  或换一种方式；不要未经允许重试同样的操作。」+ tool_result 摘要"（用户已拒绝）" ms=0。
- **R8 串行执行**：tool_calls 按数组顺序逐个执行；preview(args) 先求值再交闸门。

### 允许偏差（不收敛，登记在案）

| 偏差 | 版本 | 理由 |
| --- | --- | --- |
| 工具异常防线归属：循环内 try/catch 折叠「错误：…」 vs 循环无 catch、工具契约自守（返回错误文本、不得 panic） | ts/py/cs 前者，go/rust 后者 | 语义同构（五出口不变量都成立）；防线深度不同。go recover / rust catch_unwind 兜底为候选演进，走搁置机制 |
| 取消通道：AbortSignal / context.Context / CancellationToken / 无 | ts / go / cs / py+rs | 平台差异（Event 主题已登记真取消矩阵） |
| 取消落在工具执行中：折叠为「错误：…」再由 provider 层中止 vs OperationCanceledException 显式 rethrow（不吞、让断尾修复接手） | ts vs cs | 终态同为 aborted，历史消息形态不同；cs 为加严 |
| 错误原因取值 e.message / str(e) / e.Message | ts/py/cs | 语言惯用 |
| 熔断总结请求"不带工具"的表达（不传键 / 显式空集） | 各版 | 语义一致 |
| deps 形态（rust 把 App 提为显式参数） | rs | 借用规则的结构性差异 |

## 边界与依赖方向

- 循环经 deps 使用 provider（chat）、registry（tools）、app（planMode 状态）、
  check（权限回调）、四类事件回调；对这些能力零内联实现。
- 重试归 providers 层；断尾修复、落盘、终态事件归 turn 层；preview 文本归工具。
- 依赖方向：core → kernel（types/app 词汇）；循环不 import providers 的具体协议实现。

## 五版落点

| 版本 | 循环 | 熔断常量 | Plan Mode 拒写 |
| --- | --- | --- | --- |
| tcode | `src/core/agentloop.ts:30-102` | `agentloop.ts:11` | `agentloop.ts:59-63` |
| pcode | `pcode/core/agent_loop.py:44-125` | `agent_loop.py:22` | `agent_loop.py:76-86` |
| gcode | `internal/core/agentloop.go:44-119` | `agentloop.go:18` | `agentloop.go:69-76` |
| rcode | `src/core/agentloop.rs:41-125` | `agentloop.rs:14` | `agentloop.rs:71-79` |
| ccode | `core/AgentLoop.cs:46-125` | `AgentLoop.cs:39` | `AgentLoop.cs:70-77` |

## 反例清单（对抗式审查）

- tool_call 无配对 tool 消息（悬空）→ API 非法，循环不变量被破。
- 模型永远要工具 → 第 41 次请求必为无工具总结（五版锁测试：请求计数 41、
  消息 82 条、终态 completed）。
- 熔断总结请求仍带工具 schema（会继续打转）。
- 工具抛错上抛中断本轮（ts/py/cs 必须折叠；go/rust 契约禁止 panic）。
- Plan Mode 下 needsPermission 工具真的执行 / 发出 tool_call 事件 / 走了闸门
  （判定在四者之前）。
- Plan Mode 拒写 ms≠0 或与 tool_call 事件成对出现。
- 未知工具静默跳过（必须回错误文本供模型纠正——事件层"不发事件"与
  消息层"必落 tool 消息"并行不悖）。
- provider 错误被循环吞掉或循环内重试。
- 并行执行 tool_calls（契约串行）。

## 低置信区

- ccode 未新增熔断/折叠锁测试（本机无 .NET SDK，新增文件无法编译验证）；
  既有 PlanModeTests 覆盖拒写路径。
- go/rust 的 panic 兜底缺失未收敛（候选演进，走路线图搁置机制）。
- 熔断锁测试按"恰好 41 次请求"锁定常量；若未来调 40 常量需同步改测试（常量是契约）。
- 行号为 2026-09-27 快照，会随代码漂移。

## 验证记录（2026-09-27）

- 单测：ts 49/49（新增 `test/loop.test.ts` 熔断+折叠 2 例，已入 `npm test` 清单，
  `tsc --noEmit` 干净）、pcode 53/53（新增 `test_agent_loop.py` 2 例）、
  gcode `internal/core` ok（新增 `loop_test.go` 熔断 1 例）、rcode 53/53
  （新增熔断 1 例）；全部一次通过，证实行为本就一致、此前仅缺覆盖。
- 本主题零源码改动（纯测试），此前的五版冒烟结果仍有效；ccode 未跑（缺 SDK）。
