# rcode

极简的本地优先 coding agent：在终端里用自然语言读代码、改代码、跑命令。
Rust 实现，同步阻塞模型，**仅两个直接依赖**（`serde_json` + `ureq`）——agent loop、
SSE 流式解析、工具执行、权限闸门、会话持久化全部手写。
同族实现：`../typescript/`（Node 版参照实现，**行为规格以此为准**）、`../python/`（Python 标准库版）、
`../go/`（Go 标准库版）。

定位：**教学为骨、可用为验收**——每个模块都能在面试里讲清楚，合起来是日常真的能用的工具。

## 依赖政策（本项目唯一的哲学让步）

Rust 标准库没有 TLS 和 JSON，而真实端点是 https——零依赖物理不可行。除此之外一切手写：

```toml
[dependencies]
serde_json = "1"   # JSON 线格式（不引 serde derive，Value 手工操作）
ureq = "2"         # 同步阻塞 HTTP + rustls TLS（不用 tokio/async）
```

不引任何其他 crate；`ureq` 自动重定向已关闭（web_fetch 手动逐跳复检，见下）。

## 快速开始

前置：Rust 稳定工具链（`cargo build` 即可，无 nightly 特性）。

```bash
# 1. 配置模型端点（任何 OpenAI 兼容 API；本地中转、云 API 都行）
export RCODE_API_KEY=sk-xxx
export RCODE_BASE_URL=https://你的端点/v1
export RCODE_MODEL=你的模型名

# 2. 跑起来
cargo run                       # 或直接跑 target/{debug,release}/rcode（终端 REPL）
cargo run -- --yolo             # 跳过写/命令的逐次确认
cargo run -- --help
```

也可以在 `~/.rcode/config.json` 里写 `{"apiKey":"...","baseUrl":"...","model":"..."}`，
优先级：环境变量 > 配置文件。代码不内置任何默认端点。

其他环境变量：`RCODE_CONTEXT_LIMIT`（估算 token 预算，默认 100000）、
`RCODE_BASH`（win32 自定义 bash 路径）、`RCODE_PROTOCOL`（openai|anthropic，显式指定）。

**协议**：默认 OpenAI 兼容（`POST {BASE_URL}/chat/completions`）；`RCODE_BASE_URL` 含
`/anthropic` 时自动切换 Anthropic Messages 协议（`POST {BASE_URL}/v1/messages`，
如 DeepSeek 的 `https://api.deepseek.com/anthropic`）。Anthropic 端点的 BASE_URL
填到 `/anthropic` 为止，不要带 `/v1`。

## 会话内命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 帮助 |
| `/new` | 开新会话（清空上下文，换新会话文件） |
| `/resume [编号]` | 恢复历史会话；无编号列出最近 5 个 |
| `/compact` | 把当前对话压缩成摘要，释放上下文预算 |
| `/yolo` | 切换本会话免确认模式 |
| `/exit` | 退出 |

**已知局限（v1 取舍）**：轮中 `Ctrl+C` 直接退出进程（SIGINT 默认行为），
不支持"中止本轮、保留上下文"——tcode 支持（流式中=中止本轮；权限确认中=拒绝本次；
空闲=退出），这是 rcode 尚未移植的部分。

## 工具集（八个）

| 工具 | 确认 | 说明 |
| --- | --- | --- |
| `read` | 免 | 带行号读文件，offset/limit 分段，>1MB 拒读 |
| `glob` | 免 | ripgrep 列文件，尊重 .gitignore |
| `grep` | 免 | ripgrep 搜内容 |
| `todo` | 免 | 会话内任务清单（插件 API 活样例） |
| `write` | 逐次 | 整文件写入，确认时展示全文（4000 字截断） |
| `edit` | 逐次 | 精确字符串替换，old_string 必须唯一（apply_edit 纯函数） |
| `bash` | 逐次 | 执行命令，输出 64KB 封顶、120s 超时强杀（win32 taskkill 杀树） |
| `web_fetch` | 逐次 | 抓公网页面文本；SSRF 防线：仅 http/https、拒绝私有/保留地址、重定向逐跳复检（≤5 跳）、20s 超时、512KB 上限 |

安全模型：**权限闸门是唯一边界**。写类操作逐次展示"将写入什么/将执行什么"，
路径越出当前工作目录时确认界面会醒目警示；`--yolo` 或回答 `a` 放行整个会话。
注意"本地优先"的含义：文件与命令都在本机，但对话上下文会发给你配置的模型端点。

## 上下文与记忆

- 会话逐行落盘到 `~/.rcode/sessions/*.jsonl`（首行 meta，schema 与 tcode 一致），
  `/resume` 读旧换新，永不改写旧文件。
- 上下文治理（`/compact` 或轮前自动触发）：估算 token 超预算（默认 10 万，`RCODE_CONTEXT_LIMIT`
  可调）时，先调当前模型把历史压成一条任务摘要（保留目标/步骤/路径/未完成事项，请求 20s 超时）；
  压缩失败才退回裁剪——从最旧的工具输出裁起（替换为占位文本，最近 12 条不动，
  assistant↔tool 配对结构保持合法）。摘要失败时原历史原封不动，compact 永不破坏会话。
- 事件模型：`turn` 是唯一生产者，经 `AgentEvent`（`src/kernel/types.rs`）发出规范事件流，
  REPL 壳只订阅渲染——审计/回放/换壳都消费同一份事件契约。
- 指令注入：`~/.rcode/AGENTS.md`（全局）+ 项目根 `AGENTS.md`，按序拼进 system prompt。
- 429/5xx/网络错误指数退避重试（最多 3 次，仅首字节前；流已开始不重试，避免内容重复）。

## 架构导览

五层结构 + 插件注册表（一切能力皆插件）：

```
src/
├── kernel/        # 特权核心：四类插件+注册表、App 装配、配置、共享工具、线格式类型与 AgentEvent
├── core/          # agentloop、turn、compact（摘要压缩）、trim（裁剪兜底）、session、permission、systemprompt
├── providers/     # openai / anthropic 客户端+插件，sse/retry 共用件
├── plugins/       # mod.rs 唯一清单；tools/×8 + pathguard/netguard/rg 共用件；commands/×6
├── shell/         # repl 壳（TUI/单发是未来的并列壳）
└── main.rs        # 装配：注册插件 → 创建 App → 起壳
```

- 依赖方向（只能向左/向下）：`kernel ← core ← providers / plugins/* ← shell ← main`。
- 加能力只写一个文件 + 清单一行，活例是 `src/plugins/tools/todo.rs`。
- 对话核心（provider/agentloop）不依赖任何终端 API，换壳不动核心。
- 全项目单线程同步模型，插件回调统一 `Rc<dyn Fn>`（不需要 Send/Sync）。
- 分层铁律：[ARCHITECTURE.md](ARCHITECTURE.md)；入门导读：[docs/guides/学习指南.md](docs/guides/学习指南.md)。

## 开发

```bash
cargo build         # 构建
cargo test          # 单测（事件序列、compact、edit 唯一性、trim、netguard、registry）+ 端到端冒烟
```

冒烟测试在 `tests/smoke.rs`：手写 `TcpListener` 假 SSE 服务器按剧本回包，
被测对象是构建出的二进制（子进程跑完整 REPL：工具闭环 / /resume / Anthropic 协议 /
SSRF 拦截 / 权限 allow+deny 两轮），无任何真实网络依赖。

## 与 tcode 的行为差异

1. 无 web 壳（tcode 有 `web` 浏览器版与 Tauri 桌面版；rcode 只有 REPL 壳）。
2. `Ctrl+C` 语义：轮中直接退出进程（tcode 支持"流式中=中止本轮；权限确认中=拒绝本次"）。
   Rust 标准库没有信号处理器（需 `ctrlc` crate，破坏两依赖政策），R2 轮中真取消不移植；
   由此 `TurnEndReason::Aborted` 变体保留但无生产者，compact 摘要请求靠 20s 超时兜底。
3. 事件细节：`compact`/`usage` 事件暂无生产者（tcode 在 R3/R5 接入；rcode 的 compact
   走 `/compact` 命令打印与轮前静默治理）。

其余行为规格（事件模型、agent loop、八工具、权限闸门、compact+trim 治理、会话、双协议、
重试）与 tcode 一致；另见文首依赖政策（serde_json/ureq 两个直接依赖是 Rust 标准库缺口下的
唯一让步）。

## 验收（真实模型端到端）

拿一个故意带 bug 的玩具项目（如 `../typescript/fixtures/acceptance/`）：

```bash
cd 那个目录 && node --test   # 基线：4 绿 1 红
rcode --yolo
> 跑 node --test，修复 mod 让全部用例变绿，再跑一遍确认
```

通过标准：无人值守完成"跑测试 → read/edit 修复 → 复跑全绿"。
