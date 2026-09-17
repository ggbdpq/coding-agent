# tcode

极简的本地优先 coding agent：在终端里用自然语言读代码、改代码、跑命令。
核心全部零依赖手写（agent loop / SSE 流式解析 / 工具执行 / 权限闸门 / 会话持久化），
Node 24 原生类型剥离直跑 `.ts`，没有构建步骤。
同族实现：`../pcode/`（Python 标准库版）、`../gocode/`（Go 标准库版），行为规格一致。

定位：**教学为骨、可用为验收**——每个模块都能在面试里讲清楚，合起来是日常真的能用的工具。
参考坐标：[pi-from-scratch](https://github.com/SaladDay/pi-from-scratch)（从零手写的路子）、
[apache/maka](https://github.com/apache/maka)（工业版长什么样的对照读物）。

## 快速开始

前置：Node ≥ 24（用了原生 TypeScript 类型剥离）。运行时零依赖，无需 `npm install`。

```bash
# 1. 配置模型端点（任何 OpenAI 兼容 API；本地中转、云 API 都行）
export TCODE_API_KEY=sk-xxx
export TCODE_BASE_URL=https://你的端点/v1
export TCODE_MODEL=你的模型名

# 2. 跑起来
node bin/tcode.js            # 或 npm start（终端 REPL）
node bin/tcode.js web        # 浏览器版：起本地服务，打印地址后用浏览器打开
node bin/tcode.js --yolo     # 跳过写/命令的逐次确认
```

也可以在 `~/.tcode/config.json` 里写 `{"apiKey":"...","baseUrl":"...","model":"..."}`，
优先级：环境变量 > 配置文件。代码不内置任何默认端点。

**浏览器版（`tcode web`）**：同一内核换 web 壳——本地 HTTP 服务 + SSE 流式 + 单文件 UI，
零新依赖。安全闸：只绑 127.0.0.1、URL 携带随机 token、Host/Origin 双校验（防浏览器里
任意网页对 localhost 发请求触发命令执行）。想要独立窗体，用浏览器"安装为应用"即可。

**桌面版（`desktop/`，Tauri 2）**：把 web 壳包成原生窗体。启动时自动拉起
`node bin/tcode.js web`（要求系统 PATH 里有 Node 24，模型配置走 `~/.tcode/config.json`），
拿到地址后窗口接管，关窗即退出并清理后端进程。开发流程：

```bash
cd desktop
npm install
npm run gen:icon && npm run icon   # 图标（已生成过可跳过）
npx tauri build                    # 产物在 src-tauri/target/，~5MB 级（复用系统 WebView2 + 本机 Node）
```

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
| `/yolo` | 切换本会话免确认模式 |
| `/exit` | 退出 |

`Ctrl+C`：回答流式中=中止本轮；权限确认中=拒绝本次；空闲=退出。

## 工具集（八个）

| 工具 | 确认 | 说明 |
| --- | --- | --- |
| `read` | 免 | 带行号读文件，offset/limit 分段 |
| `glob` | 免 | ripgrep 列文件，尊重 .gitignore |
| `grep` | 免 | ripgrep 搜内容 |
| `todo` | 免 | 会话内任务清单（插件 API 活样例） |
| `write` | 逐次 | 整文件写入，确认时展示全文 |
| `edit` | 逐次 | 精确字符串替换，old_string 必须唯一 |
| `bash` | 逐次 | 执行命令，输出封顶、超时强杀 |
| `web_fetch` | 逐次 | 抓公网页面文本；SSRF 防线：仅 http/https、拒绝私有/保留地址、重定向逐跳复检 |

安全模型：**权限闸门是唯一边界**。写类操作逐次展示"将写入什么/将执行什么"，
路径越出当前工作目录时确认界面会醒目警示；`--yolo` 或回答 `a` 放行整个会话。
注意"本地优先"的含义：文件与命令都在本机，但对话上下文会发给你配置的模型端点。

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
npm install          # 仅装 devDependencies（typescript/@types/node），运行时不需要
npm run check        # tsc --noEmit 类型检查
npm test             # 单测（edit 唯一性、上下文裁剪）
npm run smoke        # 端到端冒烟：本地假 SSE 服务器，无网络依赖
```

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
