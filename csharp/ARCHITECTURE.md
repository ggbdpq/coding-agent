# ccode 架构

> 改 `src/`（这里是仓库根下的各层目录）之前先读这篇。目标：结构能从当前的千行级长到百万行级而不塌。
> 参照系是 tcode 的 "everything-is-a-plugin" 内核（其思想源自 deepseek-harness 的 dsh），
> 实现保持零依赖手写——抄思想，不抄框架。

## 一张图

```
Program.cs ──装配──▶ kernel ──▶ plugins（PluginList 清单）──▶ shell(Repl)
                      │             │
                      │             ├── tools/     八个内置工具 + pathguard/netguard/rg 共用件
                      │             ├── commands/  五条斜杠命令
                      │             └── (providers) anthropic / openai
                      ▼
                    core/  agentloop · turn · trim · session · permission · systemprompt
```

依赖方向（只能向左/向下）：

```
kernel  ←  core  ←  providers / plugins/*  ←  shell  ←  Program.cs
```

- **kernel 不 import 任何其他层**（类型除外时也不行——用结构化接口注入，
  如 `ISessionStore` 定义在 kernel，实现 core/Session.cs）。
- core 不 import providers/plugins/shell；providers/plugins 不 import shell。
- 违反这条的 PR 直接打回，没有例外。这是百万行目标下唯一靠自觉守不住的东西。

## 五层的职责

| 层 | 目录 | 职责 | 现有文件 |
| --- | --- | --- | --- |
| kernel | `kernel/` | 插件 API、注册表、App 装配、配置、共享工具 | Types（线格式）/Plugin+Registry/App/Config/Ui |
| core | `core/` | agent loop、轮编排（断尾修复）、上下文裁剪、会话、权限、系统提示词 | AgentLoop/Turn/Trim/Session/Permission/SystemPrompt |
| providers | `providers/` | 协议客户端 + provider 插件 + 共用 HttpClient | OpenAi/Anthropic/Sse/Retry |
| plugins | `plugins/` | 工具与命令插件 + 显式清单 | tools/×11（8 插件 + PathGuard/NetGuard/Rg 共用件） commands/×5 PluginList |
| shell | `shell/` | 交互壳：repl（终端） | Repl（含 LineSource 与 Ctrl+C 三态路由） |

## 插件模型

四类插件，统一 `Plugin` 抽象基类（`abstract string Kind` + `abstract string Name`），靠 Kind 判别：

| kind | 基类 | 关键成员 | 现有插件 |
| --- | --- | --- | --- |
| `tool` | `ToolPlugin` | Description/Parameters/NeedsPermission/Preview/RunAsync | read write edit bash glob grep todo web_fetch |
| `command` | `CommandPlugin` | Usage/Summary/RunAsync(app,args)→CommandOutcome | help new resume yolo exit |
| `provider` | `ProviderPlugin` | Matches(baseUrl)/Create(config) | anthropic openai（兜底） |
| `shell` | `ShellPlugin` | StartAsync(app) | repl（tcode 的 web 壳不在本版范围） |

装配规则（`plugins/PluginList.cs` 是唯一清单）：

1. **显式清单，不扫目录**——加插件 = 加文件 + 清单一行，装配顺序可读可预测。
2. provider 按注册顺序取首个 `Matches` 命中者；`openai` 恒真，必须放最后。
3. 运行环境通过 `App` 注入（Config/Registry/Provider/Store/Yolo/Messages +
   StartSession/ResetMessages），插件之间互不引用，全部找 App 要。

## 什么在 core、什么进注册表（对齐 tcode Q4 决策）

- **插件化**：tool / provider / command / shell——高频扩展面。
- **留在 core**：AgentLoop（灵魂考点，插件化它的收益是给生态换驱动，现在没有）、
  PermissionGate（安全边界不开放替换）、Trim / Session / SystemPrompt（同属核心语义）。
- 它们仍是接口化可替换的（如 Permission 的 IPermissionIO 注入），只是不进注册表；
  PathGuard/NetGuard/Rg 这类共享工具函数就是普通静态类，同样不进注册表。

## 可取消性架构（本版的中心设计）

三态语义由三件东西配合完成：

1. **路由**（`shell/Repl.cs` 的 `Console.CancelKeyPress` 处理器）：
   `e.Cancel = true` 阻止默认退出，然后按当前状态分流——权限确认中 → `LineSource.Interrupt()`；
   回答流式中 → `turnCts.Cancel()`；空闲 → `LineSource.Interrupt()`（REPL 视作退出）。
2. **令牌贯穿**：轮开始时建 `CancellationTokenSource`，令牌经 `TurnHooks` → `ChatOptions.CancellationToken`
   传进 `HttpClient.SendAsync` 与 SSE 流读循环（`StreamReader.ReadLineAsync(token)`），
   取消即抛 `OperationCanceledException`；bash 工具同样收令牌，取消时 `taskkill /T /F` 杀树。
3. **断尾修复**（`core/Turn.cs` 的 RepairTail）：取消留下"有工具调用、无回应"的缺口时，
   补 `（用户中止，未执行）` 占位，保证消息序列对 API 依然合法，然后照常落盘。

配套纪律：`providers/Retry.cs` 对 `OperationCanceledException` 绝不重试；
`SharedHttp.Client` 总超时 `Timeout.InfiniteTimeSpan`，单请求超时由链接 CTS
（`CreateLinkedTokenSource` + `CancelAfter`）自己管，web_fetch 的 20s 预算就是这么实现的。

## HttpClient 约束

- 全项目共用一个 `SharedHttp.Client`：`SocketsHttpHandler { AllowAutoRedirect = false }`，
  `Timeout = Timeout.InfiniteTimeSpan`。
- 关自动重定向是 SSRF 防线的一部分：web_fetch 手动逐跳复检（字面校验 + DNS 复检），≤5 跳。
- 单请求超时用链接 CTS 自己管，不用 HttpClient 总超时（那会连流式读取一起掐）。

## 测试策略

- 手写轻量断言运行器（`tests/TestRunner.cs`）：逐个跑断言方法，输出「N 通过 / M 失败」，
  以失败数作退出码；零第三方依赖，不引 xunit/MSTest/NUnit。
- TDD 接缝（判定表类纯函数先行）：EditTool.ApplyEdit、Trim、NetGuard、Registry。
- 端到端冒烟（`tests/Smoke.cs`）：`TcpListener` 手写假 SSE 服务器按剧本回包，
  驱动 `dotnet build` 出的 ccode 子进程（HOME/USERPROFILE 隔离），五场景 A/B/C/D/F。

## 与 tcode 的结构差异

| 差异 | 原因 |
| --- | --- |
| 无 web 壳 / desktop 层 | 本版范围限定 REPL；C# 侧可取消性是优先考点 |
| 无 node:readline 依赖的 SIGINT 路由 | 改用 `Console.CancelKeyPress` + `LineSource`，语义反而更完整（真取消） |
| 线格式 JSON 显式映射（kernel/Types.cs 的 ChatMessageJson） | System.Text.Json 无 TS 的结构化隐式性，显式映射让 tcode 同构的 wire 形状可审查 |
| 测试自建运行器 | 零依赖硬约束下不引测试框架 |
