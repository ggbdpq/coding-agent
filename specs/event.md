# Event —— 规范事件流（AgentEvent）

一句话：turn 是唯一生产者、壳/审计/回放是消费者的事件词汇表——10 个事件类型、
终态三值、每轮恰一个 turn_end。权威出处：`impls/typescript/src/kernel/types.ts`
（发射点 `impls/typescript/src/core/turn.ts`）。

状态：正文 v1（2026-09-27）。基于五版源码静态比对 + 单测与冒烟验证；
两处分歧已按写作约定 1 裁决并修复（见"分歧裁决"）。

## 本质约束

1. 事件流是壳/审计/回放的唯一事实源：加功能 = 加事件类型，不动消费端接口。
2. turn 是唯一生产者——壳只订阅不拼装，事件语义全项目只有一份。
3. 每轮恰发一个 `turn_end` 终态事件，消费者永不悬挂（含异常路径：先断尾修复、
   落盘，再发终态，然后上抛）。
4. 事件是运行时契约：session JSONL 落盘的是消息不是事件；字段拼写随各语言惯用
   大小写，语义必须同构。

## 语言中立规则

- **R1 事件集**（10 个，类型名是契约）：`turn_start / user / text_delta / tool_call /
  tool_result / permission / trimmed / compact / usage / turn_end`。
- **R2 顺序契约**：`[compact|trimmed]* → turn_start → user → (usage|text_delta|
  tool_call|tool_result)* → turn_end`；治理事件先于 turn_start。
- **R3 turn_start.id** 本轮唯一（uuid 或进程内唯一串均可）。
- **R4 正文与结果**：text_delta 只走模型正文（工具参数不走）；tool_result.summary
  恒取结果首行；ms 为真实耗时，用户拒绝/Plan Mode 拒写场景 ms=0（拒写文本也回流）。
- **R5 tool_call 时机**：执行前、权限检查前发出；未知工具不发任何事件（直接跳过）。
- **R6 usage**：双字段 `prompt_tokens/completion_tokens`；来源 openai 协议
  `include_usage` 尾分片、anthropic 协议 `message_start/message_delta`；无用量不触发。
- **R7 终态**：`turn_end.reason` 三值——completed=模型收尾；aborted=用户取消；
  error=异常且携带错误消息。aborted/error 判定按平台惯用取消信号
  （AbortError 名 / ctx 取消 / OperationCanceledException / KeyboardInterrupt）。
- **R8 断尾修复**：异常可能留下悬空 tool_call，补占位 tool 消息保证 API 合法；
  占位文本为家族统一契约「（用户中止，未执行）」（不区分原因）。
- **R9 permission 事件**：壳级闸门契约（id/tool/preview），当前生产者仅 tcode web 壳
  （id 为 p{自增序号}）；其余版本为占位类型。

### 允许偏差（不收敛，登记在案）

| 偏差 | 版本 | 理由 |
| --- | --- | --- |
| aborted 无生产者（同步模型 Ctrl+C 是进程级退出） | rs | 平台能力差异，枚举保留对齐契约 |
| compact 字段名 savedTokens / saved_tokens / SavedTokens | 各随语言惯用 | 事件是运行时对象，非跨语言线格式 |
| permission 事件复用 Name 字段承载工具名 | go | 结构体内部形状，语义同构 |
| 事件载体类名 ToolCallEvent | py | 避让线格式 ToolCall TypedDict 撞名 |
| 数值宽度 ms/usage/count 各语言原生整型 | 全体 | 同上 |

## 边界与依赖方向

- 事件词汇表住 kernel/types（各语言对应文件）；core/turn 依赖它生产，壳依赖它消费，
  禁止壳反向拼装事件。
- provider 不产生 AgentEvent——经 on_text/on_tool_call/on_tool_result/on_usage 回调
  上抛，由 turn 转译为规范事件（provider 词汇与规范词汇解耦）。
- 事件不落 session JSONL：落盘的是 ChatMessage 流，事件是运行时投影。

## 五版落点

| 版本 | 类型定义 | 发射点 |
| --- | --- | --- |
| tcode | `src/kernel/types.ts:49-59` | `src/core/turn.ts` |
| pcode | `pcode/kernel/types.py:87-181` | `pcode/core/turn.py` |
| gcode | `internal/kernel/types.go:87-140` | `internal/core/turn.go` |
| rcode | `src/kernel/types.rs:204-231` | `src/core/turn.rs` |
| ccode | `kernel/Types.cs:48-93` | `core/Turn.cs` |

## 分歧裁决（2026-09-27，写作约定 1：要么改代码要么改规格）

1. **py 异常路径不发 turn_end**（4/5 版本发）→ 违反"每轮恰一个终态"本质，判定为
   历史移植偏差而非平台限制（异常路径本就执行断尾修复，补发事件零成本）。
   修复：`pcode/core/turn.py` 异常路径 KeyboardInterrupt→aborted、其余→error，
   发完仍上抛；`test_events.py` 三例断言翻转锁定（修前 assertNotIn 红）。
   同步修正 types.py 两处注释与两份 guide 的过时描述。
2. **rust 断尾占位文本「（本轮出错，未执行）」** vs 家族统一「（用户中止，未执行）」
   （ts/py/go/cs 四版同文）→ 文本随会话落盘、属家族契约，取准绳+多数。
   修复：`turn.rs` 文本对齐；新增 `fix_dangling_tool_calls` 纯函数单测锁定
   （go 同法加绿锁）。按因区分文案记入低置信区，作五版同步演进的候选。
3. **cs Types.cs 注释过时**："Permission/Usage 本版尚无生产者"与事实不符
   （Usage 自 v0.5 由 Turn 发出）→ 注释已修正（纯注释改动）。

## 反例清单（对抗式审查）

- 壳直接拼装/伪造事件（违反唯一生产者）。
- 消费者依赖"异常路径无 turn_end"的旧 py 契约——已废弃，会在每轮异常末多收一个事件。
- turn_start 前出现 usage/text_delta；turn_end 后出现任何事件（R2 顺序违反）。
- tool_result.summary 非首行；正常执行缺 ms；拒绝场景 ms≠0。
- 未知工具名发出 tool_call 事件。
- 断尾补占位使用非契约文案。
- error 终态不携带错误消息（五版契约：error 必带）。
- provider 直接 emit AgentEvent（越层）。
- 同一轮发出两个 turn_end / 零个 turn_end。

## 低置信区

- ccode 本机无 .NET SDK：Types.cs 注释修正未编译复跑（纯注释改动，风险面 = 0）；
  EventTests 既有断言未随本轮复跑（源码行为未动）。
- permission 事件仅 tcode web 壳有生产者，web 壳无五版对照面。
- turn_start.id 唯一性口径：rust 为「毫秒时间戳+进程内序号」，跨进程理论上可重复；
  当前无消费方依赖全局唯一，暂不裁决。
- 五版落点行号为 2026-09-27 快照，会随代码漂移。

## 验证记录（2026-09-27）

- 单测：pcode 51/51（含翻转后 3 例）、rcode 51/51（含新增占位契约例）、
  gcode `internal/core` ok（含新增占位绿锁）；tcode 本主题零改动（Context 轮 47/47 已验）。
- 冒烟：pcode A/B/C/D/F/H 全过、rcode 7/7、gcode ok（缓存命中，源码未变）；
  ccode 未跑（环境缺 .NET SDK）。
