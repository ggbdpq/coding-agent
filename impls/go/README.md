# gcode

极简的本地优先 coding agent：在终端里用自然语言读代码、改代码、跑命令。
Go 标准库实现，**零第三方依赖**（`go.mod` 无任何 require）——agent loop、SSE 流式解析、
工具执行、权限闸门、会话持久化全部手写。
同族实现：`../typescript/`（Node 版参照实现，行为规格以此为准）、`../python/`（Python 标准库版）。

定位：**教学为骨、可用为验收**——每个模块都能在面试里讲清楚，合起来是日常真的能用的工具。

## 快速开始

前置：Go ≥ 1.26。

```bash
# 1. 配置模型端点（任何 OpenAI 兼容 API；本地中转、云 API 都行）
export GCODE_API_KEY=sk-xxx
export GCODE_BASE_URL=https://你的端点/v1
export GCODE_MODEL=你的模型名

# 2. 跑起来
go run ./cmd/gcode            # 终端 REPL
go run ./cmd/gcode --yolo     # 跳过写/命令的逐次确认
go run ./cmd/gcode --help
```

也可以在 `~/.gcode/config.json` 里写 `{"apiKey":"...","baseUrl":"...","model":"..."}`，
优先级：环境变量 > 配置文件。代码不内置任何默认端点。

**协议**：默认 OpenAI 兼容（`POST {BASE_URL}/chat/completions`）；`GCODE_BASE_URL` 含
`/anthropic` 时自动切换 Anthropic Messages 协议（`POST {BASE_URL}/v1/messages`，
如 DeepSeek 的 `https://api.deepseek.com/anthropic`），也可用 `GCODE_PROTOCOL=openai|anthropic`
强制指定。Anthropic 端点的 BASE_URL 填到 `/anthropic` 为止，不要带 `/v1`。

其他环境变量：`GCODE_CONTEXT_LIMIT`（估算 token 预算，默认 100000）、
`GCODE_BASH`（win32 自定义 bash 路径）。

## 会话内命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 帮助 |
| `/new` | 开新会话（清空上下文，换新会话文件） |
| `/resume [编号]` | 恢复历史会话；无编号列出最近 5 个 |
| `/yolo` | 切换本会话免确认模式 |
| `/compact` | 把当前对话压缩成摘要（调当前模型），释放上下文预算 |
| `/exit` | 退出 |

**Ctrl+C 语义（v0.3）**：回答/工具进行中按 `Ctrl+C` = 取消本轮——HTTP 请求断开、
bash 进程树被杀、回到提示符，已产生的上下文保留；再次按下 = 强制退出进程。
空闲（提示符处）按 `Ctrl+C` = 退出。

## 工具集（八个）

| 工具 | 确认 | 说明 |
| --- | --- | --- |
| `read` | 免 | 带行号读文件，offset/limit 分段，>1MB 拒读 |
| `glob` | 免 | ripgrep 列文件，尊重 .gitignore |
| `grep` | 免 | ripgrep 搜内容 |
| `todo` | 免 | 会话内任务清单（插件 API 活样例） |
| `write` | 逐次 | 整文件写入，确认时展示全文（4000 字截断） |
| `edit` | 逐次 | 精确字符串替换，old_string 必须唯一 |
| `bash` | 逐次 | 执行命令，输出 64KB 封顶、120s 超时强杀（win32 taskkill 杀树） |
| `web_fetch` | 逐次 | 抓公网页面文本；SSRF 防线：仅 http/https、拒绝私有/保留地址、重定向逐跳复检 |

安全模型：**权限闸门是唯一边界**。写类操作逐次展示"将写入什么/将执行什么"，
路径越出当前工作目录时确认界面会醒目警示；`--yolo` 或回答 `a` 放行整个会话。
注意"本地优先"的含义：文件与命令都在本机，但对话上下文会发给你配置的模型端点。

## 上下文与记忆

- 会话逐行落盘到 `~/.gcode/sessions/*.jsonl`（首行 meta），`/resume` 读旧换新，永不改写旧文件。
- 估算 token 超预算（默认 10 万，`GCODE_CONTEXT_LIMIT` 可调）时，轮前治理两段式：
  先试 **compact**（调当前模型把历史压成任务摘要，替换为 `[system, 摘要]`，`/compact` 可手动触发）；
  失败（含网络错、对话太短）再退 **trim**（从最旧的工具输出裁起，替换为占位文本，
  最近 12 条不动，assistant↔tool 配对结构保持合法）。摘要失败时原历史原封不动。
- 指令注入：`~/.gcode/AGENTS.md`（全局）+ 项目根 `AGENTS.md`，按序拼进 system prompt。
- 429/5xx/网络错误指数退避重试（最多 3 次，仅首字节前；用户中止不重试）。

## 架构导览

五层结构 + 插件注册表（一切能力皆插件，自研零依赖内核）：

```
cmd/gcode/        # 装配：注册插件 → 创建 App → 起壳
internal/
├── kernel/        # 特权核心：插件类型/注册表/App 装配/配置/共享事件与线格式类型
├── core/          # agentloop、turn（事件生产者）、compact、trim、session、permission、systemprompt
├── providers/     # openai / anthropic 客户端+插件，sse/retry 共用件
├── plugins/       # plugins.go 唯一清单；tools/×8 + 共用件；commands/×6
└── shell/         # repl 壳（事件消费者；TUI/单发是未来的并列壳）
```

- 加能力只写一个文件 + 清单一行，活例是 `internal/plugins/tools/todo.go`。
- 分层铁律与决策记录：[ARCHITECTURE.md](ARCHITECTURE.md)。
- 对话核心（provider/agentloop）不依赖任何终端 API，换壳不动核心。

## 开发

```bash
go vet ./...        # 静态检查
go test ./...       # 单测（edit 唯一性、trim、compact、turn 事件序列、netguard、registry）+ 端到端冒烟
```

冒烟测试在 `internal/smoke/`：测试内 `go build` 出真二进制，起本地假 SSE 服务器
按剧本回包，子进程跑完整 REPL（工具闭环 / /resume / Anthropic 协议 / SSRF 拦截 /
权限 allow+deny 两轮 / /compact 摘要压缩），无任何真实网络依赖。

## 与 tcode 的行为差异

1. 无 web 壳（tcode 有 `web` 浏览器版与 Tauri 桌面版；gcode 只有 REPL 壳）。
2. `Ctrl+C` 细节：轮中取消/二次强退/空闲退出与 tcode 同语义；差异在权限确认中——
   tcode 是"注入拒绝本次"，gcode 是先取消本轮、确认窗仍需作答后收尾。
3. usage 事件：tcode 已把每轮 token 用量接进事件流；gcode 的 `AgentEvent` 留了
   `usage` 字段契约但 provider 尚未上报。

其余行为规格（事件模型、agent loop、八工具、权限闸门、compact+trim 两段式治理、
会话、双协议、重试、可取消性）与 tcode 一致。

## 验收（真实模型端到端）

拿一个故意带 bug 的玩具项目（如 `../typescript/fixtures/acceptance/`）：

```bash
cd 那个目录 && node --test   # 基线：4 绿 1 红
gcode --yolo
> 跑 node --test，修复 mod 让全部用例变绿，再跑一遍确认
```

通过标准：无人值守完成"跑测试 → read/edit 修复 → 复跑全绿"。
