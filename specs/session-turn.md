# Session/Turn —— 会话持久化与轮编排

一句话：会话是 `sessions/` 下的一份 JSONL（meta 行 + message 行），只追加写、失败
静默；/resume 与 /new 都是换新文件的 fork 语义。权威出处：`impls/typescript/src/core/session.ts`、
`impls/typescript/src/core/turn.ts`。

状态：正文 v1（2026-09-27）。基于五版源码静态比对 + 单测与冒烟验证；
py 的 append 捕获范围收窄已按写作约定 1 裁决修复（见"分歧裁决"）。
主题边界：治理属 [context.md](context.md)、事件词汇属 [event.md](event.md)、
工具循环属 [agent-loop.md](agent-loop.md)；本主题钉 JSONL 契约、文件生命周期、
持久化时机与 turn 编排装配图。

## 本质约束

1. 会话文件是唯一事实源：事件流是运行时投影，落盘的是 ChatMessage 流。
2. 持久化永不打断对话：写失败一律静默（"记会话是锦上添花"纪律）。
3. 旧文件不可变：/resume 与 /new 都换新文件写，绝不追加旧文件——避免把可能损坏的
   文件越写越坏。
4. 目录边界：会话所有读写都限定在会话目录内，出目录一律拒绝/返回空。

## 语言中立规则

- **R1 JSONL 契约**：一行一个 JSON，仅两种行——meta 行
  `{type:"meta", ts:<毫秒>, version, model, cwd, yolo, ...extra}` 与 message 行
  `{type:"message", message:<ChatMessage>}`。
- **R2 文件命名**：UTC 时间戳（`:`/`.` 换 `-`，Windows 文件名兼容，毫秒精度）
  + 4 字符随机后缀 + `.jsonl`。
- **R3 生命周期**：App 创建即开会话文件；/new、/resume、--continue 都换新文件并写
  新 meta 行。
- **R4 meta 业务字段**：version/model/cwd/yolo + extra 覆盖；resume 的 extra 记
  `resumedFrom`（旧文件 basename）。
- **R5 持久化时机**：轮末一次性补写本轮自 user 消息起的全部消息（mark 机制）；
  异常路径先补断尾占位「（用户中止，未执行）」、再补写、再发终态事件——顺序不可换。
- **R6 append 静默**：未 start 直接返回；任何写异常静默（不限 OSError）。
- **R7 /resume**：`listRecent(5)` 列表供编号选择；加载内容过滤 system 行；reset 后
  并入；meta 记 resumedFrom。/sessions 只列不载。--continue = `listRecent(1)` +
  同一 fork 语义。
- **R8 listRecent**：只看 `.jsonl`、排除当前文件、mtime 倒序、label = 文件内首条
  user 消息折叠空白取前 60 字符、fallback「(无用户消息)」。
- **R9 load 容错**：只收 `type==="message"` 行，坏行/空行跳过；越目录路径返回空。

### 允许偏差（不收敛，登记在案）

| 偏差 | 版本 | 理由 |
| --- | --- | --- |
| SessionSummary.mtime 内部单位：epoch 秒 vs 毫秒 | py 秒，其余毫秒 | JSONL 契约统一毫秒；内部显示类型不入契约 |
| start 路径越界：抛异常 vs 静默 return | ts/py/cs vs go/rust | 防御分支，当前流程不可达（文件名由内部生成） |
| load 收录细节：额外要求 role 非空 / canonicalize / 显式 File.Exists | go / rs / cs | 本质同为"坏文件返回空" |
| label 的「(空输入)」死分支 | 仅 ts/py | 无行为影响 |
| resume 列表时间显示 UTC vs 本地 | rs（stdlib 无时区） | 展示层 |
| resume 编号解析 double.TryParse | cs | 语言惯用 |
| turn_start id 形状 / 中止判定来源 | 见 [event.md](event.md) 允许偏差 | 已登记 |

## 边界与依赖方向

- session 住 core，经 kernel 的 SessionStoreLike 抽象被 app/turn 消费——turn 不触
  文件系统。
- 组合根把 sessions 目录装配给 store；/resume、/new、/sessions 命令只调 store 方法，
  不自行读写文件。
- turn 编排装配图：治理（Context）→ turn_start/user 事件（Event）→ 工具循环
  （Agent Loop）→ 断尾修复 + 落盘 + 终态事件（本主题 R5）。

## 五版落点

| 版本 | 会话存储 | resume / new / sessions | --continue |
| --- | --- | --- | --- |
| tcode | `src/core/session.ts` | `plugins/commands/resume.ts`、`new.ts`、`sessions.ts` | `src/main.ts:84-94` |
| pcode | `pcode/core/session.py` | `plugins/commands/resume.py`、`new.py`、`sessions.py` | `__main__.py:57-66` |
| gcode | `internal/core/session.go` | `plugins/commands/resume.go`、`new.go`、`sessions.go` | `cmd/gcode/main.go:117-132` |
| rcode | `src/core/session.rs` | `plugins/commands/resume.rs`、`new.rs`、`sessions.rs` | `src/main.rs:104-124` |
| ccode | `core/Session.cs` | `plugins/commands/Resume.cs`、`New.cs`、`Sessions.cs` | `Program.cs:57-75` |

## 分歧裁决（2026-09-27，写作约定 1：要么改代码要么改规格）

1. **py append 只捕 OSError**（session.py:63）：ts 捕一切、go/rust 逐调用忽略错误值、
   cs 捕一切——「写失败静默」的契约下，py 的窄捕获让序列化等非 OSError 异常击穿
   turn，违背"持久化永不打断对话"。判定为移植收窄偏差。修复：`except Exception`
   并注明对齐纪律；新增 `test_session.py` 2 例（非 OSError 静默 1 红转绿）。
   其余分歧全部登记为允许偏差，不收敛。

## 反例清单（对抗式审查）

- append 写失败让 runUserTurn 抛错（必须静默——修复 1 的回归锁）。
- 未 start 就 append 抛错（直接返回）。
- /resume 之后继续写旧文件（fork 语义破坏：R3）。
- load 收到越目录路径返回内容（必须空）。
- resume 载入 system 行（必须过滤，否则 system 重复注入）。
- listRecent 列出当前文件（必须排除）。
- 坏 JSON 行让 load 崩溃（跳过）。
- meta 行缺 ts、message 行缺 type 仍被收录（schema 判别必须校验）。
- 终态事件先于落盘发出（顺序：断尾 → 落盘 → turn_end）。

## 低置信区

- start 越界分支在五版当前流程均不可达（文件名内部生成），行为差异仅登记未收敛。
- smoke B 五版断言"恢复的历史随新请求发送"，覆盖 /resume 主路径；--continue 无
  专项冒烟场景。
- ccode 本机无 .NET SDK，本轮未复跑（本主题未改 csharp 源码）。
- 行号为 2026-09-27 快照，会随代码漂移。

## 验证记录（2026-09-27）

- 单测：pcode 56/56（新增 `test_session.py` 2 例，其中"非 OSError 静默"红转绿）；
  本主题未改 ts/go/rust/cs 源码。
- 冒烟：pcode A/B/C/D/F/H 全过（session.py 改动后复跑）；其余版本源码未动。
