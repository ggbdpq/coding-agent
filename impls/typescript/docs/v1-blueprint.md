# tcode v1 架构蓝图

> 2026-09-18。基于 tcode 现状（src 2162 行 / 29 文件）与三家对标
> （OpenAI Codex / ZCode / MiniMax Code）的对抗式审查。
> 原则：**最小机制 + 可组合能力 + 强安全边界**。任何新增抽象必须先回答
> "它解决了什么问题、复杂度代价多少、能不能更便宜"。
> 其余四语言（ccode/gcode/pcode/rcode）在本版验证后按各自惯用移植。

## 一、tcode 现状快照（事实）

```
src/
├── kernel/   types(线格式) plugin(四类插件) registry app(装配) config ui
├── core/     agentloop(40轮) turn(编排) trim(裁旧) session(JSONL) permission(三态) systemprompt
├── providers/ openai anthropic sse retry
├── plugins/   tools×8(+pathguard/netguard/rg) commands×5 index(清单)
└── shell/     repl web(本地HTTP+SSE)
desktop/       Tauri 壳
test/          单测17 + 冒烟6场景
```

**已站住的**：插件内核（四类+显式清单）、权限闸门语义单份、断尾修复、SSRF 三道闸、
双协议自动识别、会话 schema、web 壳与桌面壳复用同一内核、2162 行全手写零依赖。

**对抗式自审找出的结构性缺口**（按严重度）：

| # | 缺口 | 现状证据 |
| --- | --- | --- |
| G1 | **无事件模型**：壳回调是七个散参（onText/onToolCall/onToolResult/onTrimmed/...），REPL 与 web 各自拼装事件 | `core/turn.ts` TurnHooks、`shell/web.ts` 手写 sendEvent 字典 |
| G2 | **取消不完整**：AbortController 只覆盖 provider 流；bash/web_fetch 一旦启动，Ctrl+C 无法终止，只能等超时 | `core/agentloop.ts` 串行 await tool.run |
| G3 | **会话=消息日志**：无 Turn 边界、无游标、无 compact（trim 是丢历史不是压缩历史），长会话必裂 | `core/trim.ts` 占位替换 |
| G4 | **权限无记忆无沙箱**：每次会话重新问；bash 一旦放行就是全权进程；无目录白名单 | `core/permission.ts` yoloRef 单开关 |
| G5 | **工具串行**：模型并行发的多个 tool_calls 也逐个 await | 同 G2 |
| G6 | **provider 信息丢弃**：usage、reasoning、finish_reason 全扔 | `providers/*.ts` 只取 content/tool_calls |
| G7 | **无 hook**：权限确认是唯一拦截点；AGENTS.md 只读不生成（无 /init） | — |

## 二、三家调研摘要（来源：公开仓库 2026-09-18 抓取）

### OpenAI Codex（openai/codex，Rust，125k★）
- 形态：`codex-rs` 百 crate 工作台。**协议层**是双队列：UI 提交 `Op`（用户输入/中断/审批），
  核心回吐 `Event`（delta/工具事件/task 终态），UI 与核心经此解耦（app-server 把同一协议
  暴露为 JSON-RPC 给编辑器）。
- **沙箱**是独立体系：macOS Seatbelt / Linux Landlock+seccomp，配审批策略
  （untrusted/on-failure/on-request/never）与 execpolicy 策略引擎（docs/sandbox.md 指向
  官方 security 文档）。
- **compact 是一等公民**：core 里有 compact/compact_remote/compact_token_budget 等十余个
  模块——上下文压缩按 token 预算系统化处理。
- 其余：apply_patch 独立 crate（补丁即工具）、skills/slash_commands/agents_md 均有文档、
  mcp 支持内建。
- **代价**：125k★的星光之下是数量级于 tcode 的工程量（仅 core 一包就数百文件）。

### MiniMax Code（MiniMax-AI/minimax-code，Node/TS，pnpm monorepo）
- **架构分层**（docs/architecture.md 原文）：`TUI/exec/ACP → CliService → local
  Applications → Session/Turn/Agent services → Pi/providers/local tools`。
- **PiTurnRunner**（packages/agent-core/src/pi-turn-runner/）："为一个 turn 装配 pi 运行时，
  把事件流桥接为规范 RuntimeEvents；Runner 跨会话复用，但每次 runTurn 构造全新的
  Agent/EventBridge/事件队列/历史游标——**每轮状态留在轮对象里，类只拥有进程级默认值**"。
  附带 llm-retry、metrics、hooks（setLLMHook/setToolHooks）、TurnTerminationReason。
- **EventBridge**（event-bridge/）：内部事件 → 规范 RuntimeEvent 的转换层，含
  display-sanitize（展示消毒）与 plugin-capability-attribution（能力归属溯源）。
- **agent-extension 包**（用户所说 Extension SPI 的实体）：plan-mode、context-manager、
  permission、runaway-guard、session-report、skills——**能力即扩展**，全部挂在极简 pi 内核外。
- 协议纪律：`packages/protocol` 的 local.ts/runtime.ts 明确"不含 RPC 信封与 IDL 链"；
  发布有 source-inventory 清单校验（check:source）。
- **代价**：monorepo + 私有包（@mavis/*）+ third_party/vendor（pi-mono、sandbox-runtime），
  工程复杂度显著高于单包。

### ZCode（闭源；以其可见行为与本人日常使用为据）
- 无公开仓库。可核验的工程体验：Skills（markdown 能力包）、Plugins、Hooks（生命周期
  拦截）、Subagent、Plan Mode、权限模式切换、会话管理、上下文压缩、斜杠命令生态、
  多 provider。这些是"体验对标"的来源；实现细节不做虚构。

## 三、十六维对抗式对比

每维五元组：**tcode 现状 → 三家方案 → 解决的问题 → 复杂度代价 → 最小可借鉴 / 应拒绝**。

### 1. Agent Loop
- tcode：79 行单函数循环，40 轮熔断，工具错误文本回流。
- Codex：turn 状态机 + 事件驱动，重试/回退/审批穿插轮内。MCode：PiTurnRunner（轮对象 +
  终态原因枚举）。ZCode：同量级（轮内含压缩与审批）。
- 解决的问题：轮的可观测、可中断、可恢复。
- 代价：状态机化后循环不再是"一个函数"，可解释性下降。
- **借鉴**：`TurnTerminationReason` 枚举（completed/aborted/max_rounds/error）——一行类型，
  让壳与日志知道轮为何结束。**拒绝**：把 loop 拆成状态机类图。

### 2. Session / Task / Turn 状态机
- tcode：只有 messages 数组 + JSONL 日志，无 turn 边界。
- Codex：Task/Turn 有生命周期事件；MCode：Turn 对象 + termination reason + history 游标。
- 解决的问题：resume 不必全量重放；UI 能画"这轮在做第 3 件事"。
- 代价：turn 对象化会引入状态同步问题。
- **借鉴**：**最小 turn 记录**——会话 JSONL 里每轮追加一行 `{type:"turn", id, startedAt,
  reason}` 边界事件，resume 与 UI 按边界分组。**拒绝**：Task 树/多任务编排（无需求）。

### 3. Context / History
- tcode：估算 token + 裁旧占位（保留 12 条），无摘要。
- Codex：compact 全家桶（token 预算/远端/回退）。MCode：agent-extension/context-manager。
- 解决的问题：长会话不裂，且**保留任务目标不丢失**（裁剪会丢目标，摘要不丢）。
- 代价：摘要要调一次 LLM（钱+延迟+失败路径）。
- **借鉴**：`/compact` 命令 + `compactContext()`——超阈值或手动触发，用当前模型把
  "系统提示+摘要+最近 N 条"替换 messages；trim 降级为兜底。**拒绝**：token 精确计分器
  （估算够用）、远程压缩服务。

### 4. Tool Runtime
- tcode：串行 await；每工具自带超时；结果封顶。
- Codex：apply-patch 独立协议化工具；工具并发编排。MCode：tool hooks + 上下文尺寸估算器。
- 解决的问题：并行 tool_calls 的延迟；补丁类编辑的原子性。
- 代价：并发引入结果乱序与共享状态竞争（写同文件）。
- **借鉴**：**受控并发**——同轮 tool_calls 用 `Promise.all` 但**写类工具互斥**（简单队列锁）；
  `edit` 增加 replace-all 语义已有，暂不做 apply_patch 协议。**拒绝**：通用工具编排器。

### 5. 权限与 Sandbox
- tcode：进程内三态闸门 + 预览 + 路径守卫 + netguard；bash 放行即全权。
- Codex：OS 级沙箱（Seatbelt/Landlock）+ 审批策略 + 策略引擎。MCode：permission 扩展 +
  sandbox-runtime（vendor 的 fork）。
- 解决的问题：放行后的爆炸半径。
- 代价：OS 沙箱是平台工程（每 OS 一套），策略引擎是一门 DSL。
- **借鉴**：**审批策略枚举**（`--approval untrusted|on-failure|normal|never`，替换裸
  --yolo，yolo=never 别名保留）+ **写类目录白名单**（pathguard 已有 outside 标注，加
  策略：白名单内自动允许、外必问）。**拒绝**：v1 自研 OS 沙箱（正确做法是用现成机制，
  Windows 上缺统一原语，成本失控）。

### 6. 事件模型
- tcode：无统一事件。Codex：Op/Event 双队列是全系统脊梁。MCode：RuntimeEvent + EventBridge。
- 解决的问题：任何 UI（REPL/web/TUI）、审计日志、回放、测试断言全部消费同一事件流；
  加功能=加事件类型，不动消费端接口。
- 代价：一次性重构 turn 的回调为事件流；事件 schema 要维护。
- **借鉴**：**统一 `AgentEvent` 判别联合**（见蓝图 §五），turn 只发事件，壳只订阅。
  这是 v1 的**第一优先重构**。**拒绝**：事件溯源（event-sourcing 级别的持久化与回放）。

### 7. 并发 / 取消
- tcode：AbortController 覆盖 provider 流；工具不可取消；web 壳 409 防重入。
- Codex：Op=interrupt 可中断任务；MCode：取消贯通（用户取消不计失败）。
- 解决的问题：失控工具/请求的止损；二次输入排队。
- **借鉴**：① AbortSignal 传入工具 run（bash/web_fetch 杀子进程/断请求）；
  ② 轮中输入**排队**（web 壳的 409 改为队列，Enter=steer）。**拒绝**：并发多轮。

### 8. 重试恢复
- tcode：3 次退避、仅首字节前、中止不重试——已达标。Codex：模型回退（compact_model_fallback）。
- **借鉴**：provider 级**模型回退链**（主模型 429→备模型）留接口不做实现。**拒绝**：现在就做。

### 9. Provider
- tcode：双协议自动识别 + matches 插件化；usage/reasoning 丢弃。
- Codex：多 provider + 认证体系（ChatGPT 登录/API key）。MCode：api-format 三种 + BYOK。
- **借鉴**：**usage 与 finish_reason 进事件**（TurnEnd 事件带上 token 统计）；reasoning
  透传为独立事件（thinking 模型可视）。**拒绝**：OAuth 登录体系、模型目录管理。

### 10. Plugin / Extension SPI
- tcode：四类插件 + 显式清单——**已达标**，且比 MCode 的 agent-extension 更轻。
- **借鉴**：MCode 的"能力即扩展"证明现有内核够用；缺的只是**插件可见的 capability 查询**
  （toolSchemas 已有）。**拒绝**：动态加载/热插拔/插件市场。

### 11. Hook
- tcode：无（权限确认是唯一拦截点）。
- Codex/ZCode：生命周期 hook（before/after tool、turn start/end）。
- 解决的问题：不改编排代码注入行为（审计、通知、策略）。
- **借鉴**：**三个内部 hook 就够**：beforeTool（可否决）/afterTool/onTurnEnd，注册表级
  数组，默认空。权限闸门改写为内置 beforeTool hook（语义不变，机制统一）。
  **拒绝**：用户可配置的 hook DSL/外部进程 hook（ZCode 有，等真实需求）。

### 12. Prompt / AGENTS
- tcode：双层注入已达标。Codex/ZCode：`/init` 自动生成 AGENTS.md。
- **借鉴**：`/init` 命令（让 agent 扫描项目写 AGENTS.md 草稿）。**拒绝**：prompt 模板引擎。

### 13. Skill
- tcode：无。Codex：skills.md；ZCode/MCode：skills 能力包（markdown+资源的可组合能力）。
- 解决的问题：把"怎么做好某类任务"的知识包化、可分享。
- 代价：需要发现/加载/注入机制。
- **借鉴**：**v1 只做约定不写机制**——AGENTS.md 分节约定（`## Skills` 节列出可用技能
  文件路径，agent 按需 read）。等被证明不够再升级为加载器。**拒绝**：skill 注册表与
  生命周期。

### 14. MCP
- tcode：无。三家全支持。
- 解决的问题：外接工具生态的标准协议。
- 代价：stdio/SSE 双传输 + 工具发现 + 生命周期——一个中等规模子系统。
- **借鉴**：**架构预留**——MCP 工具对内核就是一个 ToolPlugin（run=调 MCP），接口已兼容；
  实现推迟到第一批真实需求。**拒绝**：v1 内置 MCP client。

### 15. Subagent
- tcode：无。ZCode/codex/MCode 有（任务委托给独立上下文的子 agent）。
- 解决的问题：主上下文免遭探索性工作的污染。
- 代价：子会话管理、结果回传、权限继承——大件。
- **借鉴**：**零机制方案先行**——system prompt 教模型"探索性搜索用 grep/glob 后只带
  结论回来"，天然不污染（现在已如此）。真正的 subagent（独立上下文+工具子集+预算）
  等 v1 事件模型稳定后做：它本质是"起一个新 messages 数组跑 runTurn 并只回传摘要"，
  事件模型就绪后是自然产物。**拒绝**：现在实现。

### 16. 持久化与可观测性
- tcode：会话 JSONL（已达标）；无 usage/审计/metrics。
- Codex：analytics/telemetry crate；MCode：metrics + session-report。
- **借鉴**：① TurnEnd 事件带 usage；② 权限决定追加进会话文件（审计=回放+谁批的）。
  **拒绝**：遥测上报（本地优先工具，永不上报）。

## 四、v1 蓝图

### 4.1 保留不动（已证明的价值）
插件内核四类与显式清单、权限闸门三态语义、断尾修复、SSRF 三道闸、双协议 matches
选择、会话 schema、web/桌面双壳复用、零运行时依赖、单包零构建。

### 4.2 v1 新增（全部对照 §三 的"最小可借鉴"）

| 新机制 | 一句话 | 替代/填补 |
| --- | --- | --- |
| `AgentEvent` 统一事件 | turn 发事件，壳订阅 | G1 散参回调 |
| 取消贯穿工具 | AbortSignal 进 tool.run，bash/web_fetch 可杀 | G2 |
| turn 记录 + 终态原因 | JSONL 加 turn 边界行 + reason | G3 前半 |
| /compact + compactContext | 摘要替换历史；trim 降为兜底 | G3 后半 |
| 审批策略枚举 + 写白名单 | --approval 替代裸 yolo；白名单内免问 | G4 |
| 写类互斥队列 | 并行 tool_calls 写类串行化 | G5 |
| usage/finish_reason 事件 | TurnEnd 带 token 统计 | G6 |
| 三 hook（beforeTool/afterTool/onTurnEnd） | 权限闸门机制统一化 | G7 前半 |
| /init | 生成 AGENTS.md 草稿 | G7 后半 |
| Skill 约定 + MCP 预留 | 约定先行，接口兼容 | 13/14 |

### 4.3 目标目录结构（演进，非重写）

```
src/
├── kernel/    不变（types 增加 AgentEvent/ApprovalPolicy/Usage；app 增 hooks 装配）
├── core/
│   ├── events.ts      # 新：AgentEvent 判别联合 + emit 函数（~40 行）
│   ├── turn.ts        # 改：回调参数 → 事件发射器；加取消传递
│   ├── compact.ts     # 新：摘要压缩（~80 行）
│   ├── hooks.ts       # 新：三 hook 数组与触发（~30 行）
│   └── 其余不变（agentloop/trim/session/permission/systemprompt）
├── providers/ 不变（usage/reasoning 解析补充）
├── plugins/   tools 不变（run 增加可选 signal 参数）；commands 增 compact/init
└── shell/     repl/web 改为订阅事件流（各自渲染器 ~100 行）
```

### 4.4 核心接口（v1 新增部分，TypeScript 签名）

```ts
// kernel/types.ts 新增
type AgentEvent =
  | { type: 'turn_start'; id: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; call_id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; call_id: string; summary: string; ms: number }
  | { type: 'permission'; id: string; tool: string; preview: string }
  | { type: 'trimmed'; count: number }
  | { type: 'usage'; prompt_tokens: number; completion_tokens: number }
  | { type: 'turn_end'; reason: 'completed' | 'aborted' | 'error'; error?: string };

// core/hooks.ts
interface Hooks {
  beforeTool?: (req: PermissionRequest) => Promise<boolean>; // 内置：权限闸门注册于此
  afterTool?: (name: string, result: string) => Promise<void>;
  onTurnEnd?: (reason: TurnEndReason) => Promise<void>;
}

// core/compact.ts
async function compactContext(app: App, hooks: { signal?: AbortSignal }): Promise<{ savedTokens: number }>;
// 摘要失败（网络/取消）时保留原 messages——compact 永不破坏会话。

// 工具签名演进（向后兼容：signal 可选）
run: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;
```

### 4.5 数据流（v1）

```
用户输入(REPL/web)
  → shell：斜杠命令走 commands；否则发 {type:'user'} 并调 Turn.runUserTurn(app, line, emitter)
  → turn：trim → push user → [loop: provider.chat(signal) ──text_delta/tool_call──▶ emitter]
       → 每 tool_call：hooks.beforeTool(=权限闸门) → tool.run(signal) → tool_result → emitter
  → 事件流 emitter：壳渲染（REPL 直写终端 / web 序列化为 SSE）+ 会话落盘订阅
  → turn_end(reason, usage)：shell 恢复提示符；usage 展示
```

### 4.6 分阶段重构路线（每阶段独立可交付、全绿后再进下阶段）

| 阶段 | 内容 | 验收 | 预估 |
| --- | --- | --- | --- |
| R1 事件化 | AgentEvent + turn 发射器 + 双壳改订阅 + 终态原因 | 六冒烟全绿 + 新增"事件序列断言"测试 | 半天 |
| R2 取消与并发 | signal 贯穿工具；写类互斥；web 排队 | 新增"轮中中止"冒烟（bash sleep 被杀） | 半天 |
| R3 compact | /compact + 阈值自动 + 失败保留原状 | 冒烟：假服务器返回摘要剧本 | 1-2 小时 |
| R4 权限策略 | --approval 枚举 + 写白名单 + 决定入审计 | 冒烟：白名单内免问 | 1-2 小时 |
| R5 usage + /init | usage 事件 + /init 生成 AGENTS.md | 冒烟断言 TurnEnd.usage | 1 小时 |
| 不排期 | MCP client / subagent / OS 沙箱 / 技能加载器 | 触发条件见 §三 | — |

### 4.7 拒绝清单（v1 明确不做，防爬坡）

事件溯源与全量回放、DI/IoC 容器、插件动态加载与市场、OS 级沙箱自研、token 精确计分、
多会话并行、TUI 全屏界面、遥测上报、Task 树编排、prompt 模板引擎、外部进程 hook DSL。

---

## 五、对标摘录备查

- MCode PiTurnRunner 头注释（原文节选）："Reusable across sessions, but every call to
  runTurn constructs a fresh Agent, EventBridge, event queue and history cursor.
  Per-turn state stays inside the turn object created by newTurn(...)"——**每轮状态
  局部化**是它最值得抄的一条纪律，v1 的 turn 记录即其最小形。
- MCode agent-extension 包构成：context-manager / permission / plan-mode / runaway-guard /
  session-report / skills——"能力即扩展"的实证，佐证 tcode 内核已够用。
- Codex compact 系统化（core 下十余个 compact* 模块）与沙箱独立化（Seatbelt/Landlock
  + execpolicy）——前者 v1 借鉴最小版，后者明确拒绝自研。
- ZCode（闭源）以其可见体验为对标：Skills/Hooks/权限模式/压缩——v1 覆盖 hook 与 compact，
  skills 用约定，权限模式用 --approval。
