# tcode

极简的本地优先 coding agent：在终端里用自然语言读代码、改代码、跑命令。
核心全部零依赖手写（agent loop / SSE 流式解析 / 工具执行 / 权限闸门 / 会话持久化），
Node 24 原生类型剥离直跑 `.ts`，没有构建步骤。
同族实现：`../python/`（Python 标准库版）、`../go/`（Go 标准库版）、`../rust/`（Rust 版）、`../csharp/`（C# 版），行为规格一致。
运行时兼容：`bun bin/tcode.js` 可直接运行（Bun 1.4 实测六场景冒烟全绿，含 node:readline 的 SIGINT 路由），主运行时仍以 Node 24 为准。

定位：**教学为骨、可用为验收**——每个模块都能在面试里讲清楚，合起来是日常真的能用的工具。
参考坐标：[pi-from-scratch](https://github.com/SaladDay/pi-from-scratch)（从零手写的路子）、
[apache/maka](https://github.com/apache/maka)（工业版长什么样的对照读物）。

## 快速开始

前置：Node 24.21.0–24.x（用了原生 TypeScript 类型剥离）。运行时零依赖，无需 `npm install`。

```bash
# 1. 配置模型端点（任何 OpenAI 兼容 API；本地中转、云 API 都行）
export TCODE_API_KEY=sk-xxx
export TCODE_BASE_URL=https://你的端点/v1
export TCODE_MODEL=你的模型名

# 2. 跑起来
node bin/tcode.js            # 或 npm start（终端 REPL）
node bin/tcode.js web        # 浏览器版：起本地服务，打印地址后用浏览器打开
node bin/tcode.js exec "修复失败的测试并跑通"   # 无交互单任务（CI/脚本用，需 --yolo）
node bin/tcode.js --continue --yolo   # 接着上次会话继续
node bin/tcode.js --yolo     # 跳过写/命令的逐次确认
```

输入里的 `@相对路径` 会把文件内容注入上下文（单文件 256KB 上限，只读安全）。


也可以在 `~/.tcode/config.json` 里写 `{"apiKey":"...","baseUrl":"...","model":"..."}`，
优先级：环境变量 > 配置文件。代码不内置任何默认端点。

**浏览器版（`tcode web`）**：同一内核换 web 壳——本地 HTTP 服务 + SSE 流式 + 单文件 UI，
零新前端依赖。未配置模型也能打开；用“打开项目”的系统目录对话框选择工作区，在“设置 → 模型”填写端点、模型和 API Key。项目选择与模型配置互相独立。已有 API Key 留空保留，读接口与页面不回显凭证。

工作台支持当前项目的会话列表、搜索、重命名、切换和刷新恢复；重启恢复最近会话，继续写入新 JSONL，保留原文件。中断轮会标记为已停止并补齐模型上下文中的工具配对，不自动重新执行未完成操作。一次只跑一轮任务；运行或等待审批时禁止切换会话和修改配置。模型错误只结束当前轮，停止会阻止后续工具继续执行。

“设置 → 常规 → 项目管理”可归档和恢复非当前项目。归档只从导航隐藏项目，保留项目目录和会话；重新打开目录或打开该项目的搜索结果会自动恢复导航。当前项目须先切换再归档，目录不可用时会显示状态。

侧栏搜索默认筛选当前项目标题；切到“所有项目”后搜索全部本地会话的标题、用户和助手正文，包括归档项目。结果显示项目归属和正文摘录，最多 50 条，并提示进一步缩小范围。点击结果恢复指定项目的会话；目录不可用或任务正在运行时不能打开。搜索不匹配系统指令、工具参数或工具输出，快速输入时旧响应不会覆盖新关键词。

手动／自动压缩及摘要失败后的工具输出裁剪，均追加上下文快照后再改变内存；切会话、重启、CLI `/resume` 或 `--continue` 继续使用压缩后的背景。界面保留完整活动历史和用量；旧消息文件不被重写。快照写入失败时保留原上下文。

左侧常驻最近项目、新任务、搜索和设置入口。独立设置中心提供常规、模型、权限、外观、用量、技能和命令七组；主题、消息字号、发送快捷键和默认审批保存在本地。临时免审批和 Plan Mode 在新任务、恢复或切项目时复位；写白名单按目标真实路径判断，符号链接指向白名单外仍须审批。

顶部可收起／展开侧栏，收起后仍可新建任务、搜索和打开设置。`Cmd/Ctrl+N` 新任务、`Cmd/Ctrl+K` 聚焦搜索、`Cmd/Ctrl+,` 设置、`Cmd/Ctrl+B` 切换侧栏；任务、审批或连接测试期间，快捷键遵循同一组操作锁。

技能设置可创建、查看和编辑全局或当前项目 `.md` 技能，保存后更新同一来源的模型技能索引。全局指令/技能遵守 `TCODE_DATA_DIR`，默认仍为 `~/.tcode`。用量页按稳定会话去重，汇总回答和手动／自动压缩请求已收到的 provider 用量；即使请求随后停止或摘要无效，已返回的用量也保留，此页并非账户账单。浏览器版使用 macOS 系统目录对话框、Windows FolderBrowserDialog，Linux 需系统已安装 `zenity`；桌面版复用原生目录选择器。

模型设置可测试**已保存的连接**：只发送一条固定短消息，不发送工具、项目内容或未保存草稿，展示耗时及本次 Token 用量。测试可取消，10 秒自动超时；本次探测用量单独显示，不计入会话统计。先保存配置再测试，测试可能产生少量模型费用。

回答支持常用 Markdown，工具卡保留完整输出，显示当前会话 Token 用量；“查看变更”只读展示 Git 已跟踪修改和新文件。Markdown 使用 DOM 文本节点，原始 HTML 按文本展示。终端模式保留原有命令，Web 中 `/resume`、`/sessions` 通过当前项目侧栏操作。

安全闸：只绑 127.0.0.1、URL 携带随机 token、Host/Origin 双校验（防浏览器里任意网页对 localhost 发请求触发命令执行）。`TCODE_DATA_DIR` 可指定独立配置与会话目录，默认仍为 `~/.tcode`。

**桌面版（`desktop/`，Tauri 2）**：把 web 壳包成原生窗体。启动时自动拉起
`node bin/tcode.js web --desktop`，首次在界面配置模型和项目。发行包携带后端源码资源，使用本机 Node 24；拿到地址后窗口接管，启动失败展示错误页，超时和关窗回收后端进程。开发流程：

```bash
cd desktop
npm ci --ignore-scripts
npm run dev
npm run build -- --bundles app,dmg # macOS；Windows 使用 --bundles nsis
```

Node 查找与桌面启动验证见 [desktop/README.md](desktop/README.md)。当前不内置 Node 运行时。

已完成、未完成及后续开发入口见 [桌面工作台开发进度](docs/desktop-workbench-progress.md)。

**协议**：默认 OpenAI 兼容（`POST {BASE_URL}/chat/completions`）；`BASE_URL` 含
`/anthropic` 时自动切换 Anthropic Messages 协议（`POST {BASE_URL}/v1/messages`，
如 DeepSeek 的 `https://api.deepseek.com/anthropic`），也可用 `TCODE_PROTOCOL=openai|anthropic`
强制指定。Anthropic 端点的 BASE_URL 填到 `/anthropic` 为止，不要带 `/v1`。

## 会话内命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 帮助 |
| `/new` | 开新会话（清空上下文，换新会话文件） |
| `/resume [编号]` | 恢复历史会话；无编号列出最近 5 个 |
| `/compact` | 把当前对话压缩成任务摘要，释放上下文预算（长会话不裂的关键） |
| `/plan` | 切换 Plan Mode（只读规划：写类工具被拒，产出计划后切回执行） |
| `/init` | 生成 AGENTS.md 起手模板（已存在则不覆盖） |
| `/sessions` | 列出最近会话（用 /resume <编号> 加载） |
| `/yolo` | 切换本会话免确认模式 |
| `/exit` | 退出 |

`Ctrl+C`：回答流式中=中止本轮；权限确认中=拒绝本次；空闲=退出。

## 上下文治理与审批策略（v0.3）

- 轮前估算 token 超过 `TCODE_CONTEXT_LIMIT`（默认 10 万）时，**先自动 /compact**（摘要
  保留任务目标），失败再降级为裁剪（丢最旧工具输出，保留最近 12 条）。
- 审批策略：`--approval never` 或 `TCODE_APPROVAL=never` 等价 `--yolo`；默认 normal。
- 写白名单：`~/.tcode/config.json` 加 `"allowWriteDirs": ["E:\\work\\sandbox"]`，
  写入这些目录的 write/edit 免逐次确认（bash/web_fetch 不受白名单影响，仍逐次确认）。

## 工具集（八个）

| 工具 | 确认 | 说明 |
| --- | --- | --- |
| `read` | 免 | 带行号读文件，offset/limit 分段 |
| `glob` | 免 | ripgrep 列文件，尊重 .gitignore |
| `grep` | 免 | ripgrep 搜内容 |
| `todo` | 免 | 会话内任务清单（插件 API 活样例） |
| `write` | 逐次 | 整文件写入，确认时展示全文 |
| `edit` | 逐次 | 精确字符串替换，old_string 必须唯一 |
| `apply_patch` | 逐次 | 多文件原子补丁：全部预验通过才写入，任一失败整体放弃 |
| `bash` | 逐次 | 执行命令，输出封顶、超时强杀；轮中可被用户中止 |
| `web_fetch` | 逐次 | 抓公网页面文本；SSRF 防线：仅 http/https、拒绝私有/保留地址、重定向逐跳复检 |

安全模型：**权限闸门是唯一边界**。写类操作逐次展示"将写入什么/将执行什么"，
路径越出当前工作目录时确认界面会醒目警示；`--yolo` 或回答 `a` 放行整个会话；
`config.allowWriteDirs` 白名单内的 write/edit 免确认（目录须绝对路径）。
注意"本地优先"的含义：文件与命令都在本机，但对话上下文会发给你配置的模型端点。

## Plan Mode 与技能（v0.5）

- `/plan` 切换只读规划：写类工具（write/edit/bash/web_fetch/apply_patch）在轮内被拒，
  模型只能 read/glob/grep 探索并产出计划；`/plan` 切回后按计划执行。
- **技能（Skills，约定式）**：把 markdown 文件放进 `~/.tcode/skills/` 或项目
  `.tcode/skills/`，系统提示词会自动注入"可用技能索引"，agent 按需用 read 读取全文。
  不做加载器——约定即机制。

## 上下文与记忆

- 会话逐行落盘到 `~/.tcode/sessions/*.jsonl`，`/resume` 换新文件重放，永不改写旧文件。
- 估算 token 超预算（默认 10 万，`TCODE_CONTEXT_LIMIT` 可调）时，从最旧的工具输出裁起
  （替换为占位文本，最近 12 条不动，assistant↔tool 配对结构保持合法）。
- 指令注入：`~/.tcode/AGENTS.md`（全局）+ 项目根 `AGENTS.md`，按序拼进 system prompt。
- 429/5xx/网络错误指数退避重试（最多 3 次，仅首字节前）。

## 架构导览

五层结构 + 插件注册表（一切能力皆插件，自研零依赖内核）：

```
src/
├── kernel/          # 特权核心：definePlugin/注册表/App 装配/配置/共享工具
├── core/            # agentloop、trim（上下文裁剪）、session、permission、systemprompt
├── providers/       # openai / anthropic 客户端+插件，sse/retry 共用件
├── plugins/         # 工具与命令插件；index.ts 是唯一清单（加插件=加文件+一行）
├── shell/           # repl 壳（tui/单发/web 是未来的并列壳）
└── main.ts          # 装配：注册插件 → 创建 App → 起壳
```

- 加能力只写一个文件：模板见 [docs/plugin-template.md](docs/plugin-template.md)，
  活例是 `plugins/tools/todo.ts`。
- 分层铁律与百万行路线图：[ARCHITECTURE.md](ARCHITECTURE.md)。
- 结构决策记录：[docs/notes/](docs/notes/)。
- 对话核心（provider/agentloop）不依赖任何终端 API，换壳不动核心。

## 开发

```bash
pnpm install --frozen-lockfile # 主包仅使用 pnpm 锁；运行时无需安装依赖
pnpm exec playwright install chromium # 浏览器回归首次安装；Linux 可加 --with-deps
npm run check        # tsc --noEmit 类型检查
npm test             # 核心测试 + 真实 HTTP/SSE、进程与文件边界回归
npm run test:web     # 仅工作台公共 HTTP/SSE 回归
npm run test:ui      # 浏览器交互（项目内固定 Playwright + 受管 Chromium）
npm run smoke        # 端到端冒烟：本地假 SSE 服务器，无网络依赖
```

使用 `packageManager` 声明的 pnpm 12.6.0 安装主包开发依赖，桌面子包继续使用其独立 `npm ci`。浏览器测试固定 Playwright 1.62.1，默认使用它下载的 Chromium；也可通过 `PLAYWRIGHT_MODULE` 指向已有 Playwright 安装、`CHROME_PATH` 指向浏览器可执行文件。CI 在 `main`／`develop` 的 push 和 PR 上包含独立浏览器回归。测试只使用假模型端点和隔离目录，不使用真实密钥。

## 验收（真实模型端到端）

`fixtures/acceptance/` 是一个故意带 bug 的玩具项目：`calc.js` 的 `mod` 对负数返回负余数，
`calc.test.js` 有一个用例是红的。验收任务：

```bash
cd fixtures/acceptance
node --test                        # 先确认基线：4 绿 1 红
tcode --yolo                       # 或 node ../../bin/tcode.js --yolo
> 跑 node --test，修复 mod 让全部用例变绿，再跑一遍确认
```

通过标准：tcode 无人值守完成"跑测试 → read/edit 修复 → 复跑全绿"。
