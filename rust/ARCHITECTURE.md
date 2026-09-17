# rcode 架构

> 改 `src/` 之前先读这篇。目标：结构能从当前的千行级长到十万行级而不塌。
> 行为规格参照 `../tcode/`（ARCHITECTURE.md 同构）；形态参照 `../gocode/` 的 internal/ 布局。

## 一张图

```
main.rs ──装配──▶ kernel ──▶ plugins（清单）──▶ shell(repl)
                  │             │
                  │             ├── tools/     八个内置工具 + pathguard/rg
                  │             ├── commands/  五条斜杠命令
                  │             └── (providers) anthropic / openai
                  ▼
                core/  agentloop · turn · trim · session · permission · systemprompt
```

依赖方向（只能向左/向下）：

```
kernel  ←  core  ←  providers / plugins/* ← shell ← main
```

- **kernel 不 import 任何其他层**——需要 core 的能力（session store、system prompt）时
  由装配方（main.rs）以 `AppOptions` 注入，kernel 只声明 `SessionStoreLike` 等结构化接口。
- core 不 import providers/plugins/shell；providers/plugins 不 import shell
  （唯一例外：plugins/mod.rs 清单引用 shell::repl 的构造函数——与 tcode 的 index.ts 同构，
  引用只发生在装配清单层）。
- Rust 模块允许互引，但本仓库刻意保持单向：违反这条的 PR 直接打回，没有例外。

## 五层的职责

| 层 | 目录 | 职责 | 现有文件 |
| --- | --- | --- | --- |
| kernel | `src/kernel/` | 插件 API、注册表、App 装配、配置、共享工具、线格式类型 | types/plugin/app/config/ui + mod |
| core | `src/core/` | agent loop、一轮编排、上下文裁剪、会话、权限、系统提示词 | agentloop/turn/trim/session/permission/systemprompt |
| providers | `src/providers/` | 协议客户端 + provider 插件 | openai/anthropic/sse/retry |
| plugins | `src/plugins/` | 工具与命令插件 + 显式清单 | tools/×8（8 插件 + rg/pathguard/netguard 共用件） commands/×5 mod.rs |
| shell | `src/shell/` | 交互壳：repl（终端）；TUI/单发是未来的并列壳 | repl |

## 插件模型

四类插件，统一 `Plugin` 枚举 + kind 判别（`src/kernel/plugin.rs`）：

| kind | 关键字段 | 现有插件 |
| --- | --- | --- |
| `Tool` | description/parameters/needs_permission/preview/run | read write edit bash glob grep todo web_fetch |
| `Command` | usage/summary/run(&mut App,args)→{exit} | help new resume yolo exit |
| `Provider` | matches(baseUrl)/create(config) | anthropic openai（兜底） |
| `Shell` | start(&mut App) | repl |

装配规则（`src/plugins/mod.rs` 是唯一清单）：

1. **显式清单，不扫目录**——加插件 = 加文件 + 清单一行，装配顺序可读可预测。
2. provider 按注册顺序取首个 `matches` 命中者；`openai` 恒真，必须放最后。
3. 运行环境通过 `App` 注入（config/registry/provider/store/yolo/messages +
   startSession/resetMessages），插件之间互不引用，全部找 App 要。

### Rust 形态的三个落点

| 决策 | 取舍 | 理由 |
| --- | --- | --- |
| 插件与回调统一 `Rc<dyn Fn>` / `Rc<ToolDef>` | 不用 `Arc`，不要求 Send/Sync | 全项目单线程同步模型；REPL 壳 + 阻塞 IO 没有并发面 |
| Registry 存 `Vec<Plugin>` 枚举 | 不用 trait object 注册自省 | kind 判别 + 重名检查/按类取用一行 match 搞定 |
| 命令拿 `&mut App`，壳先 clone `Rc<CommandDef>` 再调用 | 避开"从 App 借命令、又把 App 借出去"的双借 | `registry.commands()` 返回 owned Vec，借用即结束 |

## 什么在 core、什么进注册表（Q4 决策，对齐 tcode）

- **插件化**：tool / provider / command / shell——高频扩展面。
- **留在 core**：agentloop（灵魂考点，插件化收益是给生态换驱动，现在没有）、
  permission（安全边界不开放替换）、trim / session / systemprompt（同属核心语义）。
- 它们仍是接口化可替换的（permission 的 PermissionIO 注入、session 的 SessionStoreLike 注入），
  只是不进注册表。

## 依赖政策（README 的架构面补充）

| 依赖 | 边界 | 说明 |
| --- | --- | --- |
| `serde_json = "1"` | 全项目 JSON 唯一出口 | 不引 serde derive：`ChatMessage::to_value/from_value` 手写线格式 |
| `ureq = "2"` | providers 与 web_fetch 的 HTTP 出口 | 默认 rustls TLS；`redirects(0)` 全局关闭自动重定向 |

手写件清单（这些是"零依赖哲学"仍在生效的证据）：SSE 解析（sse.rs）、URL 最小解析与
重定向拼接（netguard.rs）、HTML 剥壳（webfetch.rs）、civil 历法（session.rs）、
ANSI 着色与 TTY 检测（ui.rs，`std::io::IsTerminal`）。

## 冒烟与测试布局

- 单测与被测同文件（`#[cfg(test)]`）：edit（apply_edit 判定表）、trim（估算/裁旧留新/幂等）、
  netguard（SSRF 判定表 + IPv6 展开形式）、plugin（注册表契约）——四个 TDD 接缝。
- `tests/smoke.rs`：`TcpListener` 手写假 SSE 服务器（按"最后一条消息角色+最新用户文本"分场），
  被测对象是 `CARGO_BIN_EXE_rcode` 指向的真二进制，子进程 REPL 全链路 5 场景（A/B/C/D/F）。

## 路线图

| 阶段 | 触发条件 | 动作 |
| --- | --- | --- |
| 现在：单 crate 分层 | — | 本文所述结构 |
| 中期：workspace 拆包 | 单 crate >1 万行或出现独立子系统（如独立 TUI） | kernel/core 拆 `crates/core`，shell 与插件拆包 |
| 远期：平台 | 有第三方写插件的真实需求 | 插件外置（动态库/目录加载 + 契约校验）、版本化插件 API |
