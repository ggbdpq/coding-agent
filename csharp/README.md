# ccode

**本版核心考点：可取消性。** tcode/pcode/gcode/rcode 的轮中 Ctrl+C 只能"杀进程"或"无法取消"；
ccode 用 `Console.CancelKeyPress`（`e.Cancel = true` 阻止默认退出）+ `CancellationTokenSource`
贯穿 provider/loop，完整移植 tcode 的三态语义，而且是四语言实现里唯一能做到干净的一版：

| 场景 | Ctrl+C 的含义 | 机制 |
| --- | --- | --- |
| 回答流式中 | 真正取消 HTTP 请求 | 取消令牌一路传到 SSE 流读循环，`ReadLineAsync(token)` 抛 `OperationCanceledException` → 断尾修复 → 回到提示符，**进程不死** |
| 权限确认中 | 拒绝本次 | `shell/Repl.cs` 的 `LineSource.Interrupt()` 注入打断事件，确认循环收到后返回 `Deny` |
| 空闲 | 退出 | 等待输入的 REPL 收到打断事件后正常走退出路径 |

极简的本地优先 coding agent（C# / .NET 8 版）：在终端里用自然语言读代码、改代码、跑命令。
核心全部零依赖手写（agent loop / SSE 流式解析 / 工具执行 / 权限闸门 / 会话持久化），
`HttpClient` 与 `System.Text.Json` 都是内置类型，csproj 没有任何 `PackageReference`。
同族实现：`../typescript/`（TypeScript 参照实现，行为规格来源）、`../python/`（Python 版）、`../go/`（Go 版），行为规格一致。

定位：**教学为骨、可用为验收**——每个模块都能在面试里讲清楚，合起来是日常真的能用的工具。

## 快速开始

前置：.NET 8 SDK。运行时零第三方依赖，无需 `dotnet restore` 拉包。

```bash
# 1. 配置模型端点（任何 OpenAI 兼容 API；本地中转、云 API 都行）
export CCODE_API_KEY=sk-xxx
export CCODE_BASE_URL=https://你的端点/v1
export CCODE_MODEL=你的模型名

# 2. 跑起来（注意 -- 后传参）
dotnet run -- --yolo      # 跳过写/命令的逐次确认
dotnet run --             # 交互式 REPL
dotnet run -- --help
```

也可以在 `~/.ccode/config.json` 里写 `{"apiKey":"...","baseUrl":"...","model":"..."}`，
优先级：环境变量 > 配置文件。代码不内置任何默认端点。

**协议**：默认 OpenAI 兼容（`POST {BASE_URL}/chat/completions`）；`BASE_URL` 含
`/anthropic` 时自动切换 Anthropic Messages 协议（`POST {BASE_URL}/v1/messages`，
如 DeepSeek 的 `https://api.deepseek.com/anthropic`），也可用 `CCODE_PROTOCOL=openai|anthropic`
强制指定。Anthropic 端点的 BASE_URL 填到 `/anthropic` 为止，不要带 `/v1`。

## 会话内命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 帮助 |
| `/new` | 开新会话（清空上下文，换新会话文件） |
| `/resume [编号]` | 恢复历史会话；无编号列出最近 5 个 |
| `/yolo` | 切换本会话免确认模式 |
| `/compact` | 把当前对话压缩成摘要，释放上下文预算 |
| `/exit` | 退出 |

`Ctrl+C` 三态：回答流式中=中止本轮（真正取消请求）；权限确认中=拒绝本次；空闲=退出。

## 工具集（八个）

| 工具 | 确认 | 说明 |
| --- | --- | --- |
| `read` | 免 | 带行号读文件，offset/limit 分段，1MB 拒读 |
| `glob` | 免 | ripgrep 列文件，尊重 .gitignore |
| `grep` | 免 | ripgrep 搜内容 |
| `todo` | 免 | 会话内任务清单（插件 API 活样例） |
| `write` | 逐次 | 整文件写入，确认时展示全文（4000 字符封顶） |
| `edit` | 逐次 | 精确字符串替换，old_string 必须唯一 |
| `bash` | 逐次 | 执行命令，输出 64KB 封顶、120s 超时 taskkill 杀树、Ctrl+C 可取消 |
| `web_fetch` | 逐次 | 抓公网页面文本；SSRF 防线：仅 http/https、拒绝私有/保留地址、重定向逐跳复检 |

安全模型：**权限闸门是唯一边界**。写类操作逐次展示"将写入什么/将执行什么"，
路径越出当前工作目录时确认界面会醒目警示；`--yolo` 或回答 `a` 放行整个会话。
注意"本地优先"的含义：文件与命令都在本机，但对话上下文会发给你配置的模型端点。

## 上下文与记忆

- 会话逐行落盘到 `~/.ccode/sessions/*.jsonl`，`/resume` 换新文件重放，永不改写旧文件。
- 估算 token 超预算（默认 10 万，`CCODE_CONTEXT_LIMIT` 可调）时，从最旧的工具输出裁起
  （替换为占位文本，最近 12 条不动，assistant↔tool 配对结构保持合法）。
- 指令注入：`~/.ccode/AGENTS.md`（全局）+ 项目根 `AGENTS.md`，按序拼进 system prompt。
- 429/5xx/网络错误指数退避重试（最多 3 次，仅首字节前；用户取消绝不重试）。

## 架构导览

五层结构 + 插件注册表（一切能力皆插件，自研零依赖内核）：

```
Program.cs          # 装配：注册插件 → 创建 App → 起壳
├── kernel/         # 特权核心：四类插件 + Registry / App 装配 / 配置 / 共享工具
├── core/           # agentloop、turn（轮编排）、trim、session、permission、systemprompt
├── providers/      # openai / anthropic 客户端+插件，sse/retry 共用件
├── plugins/        # 工具与命令插件；PluginList.cs 是唯一清单（加插件=加文件+一行）
└── shell/          # repl 壳（Ctrl+C 三态路由住这里）
```

- 加能力只写一个文件：活例是 `plugins/tools/Todo.cs`。
- 分层铁律与设计取舍：[ARCHITECTURE.md](ARCHITECTURE.md)。
- 可取消性的完整讲解：[docs/guides/学习指南.md](docs/guides/学习指南.md)。
- 对话核心（provider/agentloop）不依赖任何终端 API，换壳不动核心。

## 开发

```bash
dotnet build                                            # 主项目 + 零警告
dotnet run --project tests                              # 单测 + 端到端冒烟（本地假 SSE 服务器，无网络依赖）
```

测试是手写的轻量断言运行器（`tests/TestRunner.cs`），输出「N 通过 / M 失败」并以失败数作退出码；
冒烟用 `System.Net.Sockets.TcpListener` 手写假 SSE 服务器驱动真实 ccode 子进程（A 工具闭环 /
B /resume / C Anthropic / D SSRF 拦截 / F 权限 allow-deny 五场景）。

## 与 tcode 的差异

- 无 web 壳（`tcode web`）与 desktop 打包层——本版只有 REPL 壳。
- 无 tcode 的 Ctrl+C 局限：轮中取消是真正的 HTTP 请求级取消（见顶部核心考点）。

## 验收（真实模型端到端）

配好 `CCODE_*` 后 `dotnet run -- --yolo`，让它"read 某文件 → edit 修复 → bash 跑测试"，
通过标准与 tcode 一致：无人值守完成闭环且如实报告结果。
