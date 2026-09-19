# pcode

极简的本地优先 coding agent：在终端里用自然语言读代码、改代码、跑命令。
核心全部零依赖手写（agent loop / SSE 流式解析 / 工具执行 / 权限闸门 / 会话持久化），
只用 Python 标准库（urllib / json / subprocess / argparse / unittest / http.server），
同步阻塞模型，无 asyncio，无需 `pip install` 任何东西。
同族实现：`../typescript/`（TypeScript 版，行为规格的权威来源），本文描述的行为与它一致。

定位：**教学为骨、可用为验收**——每个模块都能在面试里讲清楚，合起来是日常真的能用的工具。

## 快速开始

前置：Python ≥ 3.12。零第三方依赖，无需安装。

```bash
# 1. 配置模型端点（任何 OpenAI 兼容 API；本地中转、云 API 都行）
export PCODE_API_KEY=sk-xxx
export PCODE_BASE_URL=https://你的端点/v1
export PCODE_MODEL=你的模型名

# 2. 跑起来（在仓库根目录）
python -m pcode            # 终端 REPL
python -m pcode --yolo     # 跳过写/命令的逐次确认
python -m pcode --help     # 帮助
python -m pcode --version  # 版本
```

也可以在 `~/.pcode/config.json` 里写 `{"apiKey":"...","baseUrl":"...","model":"..."}`，
优先级：环境变量 > 配置文件。代码不内置任何默认端点。

**协议**：默认 OpenAI 兼容（`POST {BASE_URL}/chat/completions`）；`PCODE_BASE_URL` 含
`/anthropic` 时自动切换 Anthropic Messages 协议（`POST {BASE_URL}/v1/messages`，
如 DeepSeek 的 `https://api.deepseek.com/anthropic`），也可用 `PCODE_PROTOCOL=openai|anthropic`
强制指定。Anthropic 端点的 BASE_URL 填到 `/anthropic` 为止，不要带 `/v1`。

## 会话内命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 帮助（列表从注册表自动生成） |
| `/new` | 开新会话（清空上下文，换新会话文件） |
| `/resume [编号]` | 恢复历史会话；无编号列出最近 5 个 |
| `/compact` | 把当前对话压缩成任务摘要，释放上下文预算（长会话不裂的关键） |
| `/yolo` | 切换本会话免确认模式 |
| `/exit` | 退出 |

`Ctrl+C`：直接退出进程（见下方"已知局限"）。

## 工具集（八个）

| 工具 | 确认 | 说明 |
| --- | --- | --- |
| `read` | 免 | 带行号读文件，offset/limit 分段，>1MB 拒读 |
| `glob` | 免 | ripgrep 列文件，尊重 .gitignore |
| `grep` | 免 | ripgrep 搜内容 |
| `todo` | 免 | 会话内任务清单（插件 API 活样例） |
| `write` | 逐次 | 整文件写入（自动建父目录），确认时展示全文（4000 字截断） |
| `edit` | 逐次 | 精确字符串替换，old_string 必须唯一（预览 -old/+new 各截 800） |
| `bash` | 逐次 | 执行命令，输出封顶 64KB、默认 120s 超时强杀 |
| `web_fetch` | 逐次 | 抓公网页面文本；SSRF 防线：仅 http/https、拒绝私有/保留地址、重定向逐跳复检 |

安全模型：**权限闸门是唯一边界**。写类操作逐次展示"将写入什么/将执行什么"，
路径越出当前工作目录时确认界面会醒目警示；`--yolo` 或回答 `a` 放行整个会话。
注意"本地优先"的含义：文件与命令都在本机，但对话上下文会发给你配置的模型端点。

## 上下文与记忆

- 会话逐行落盘到 `~/.pcode/sessions/*.jsonl`，`/resume` 换新文件重放，永不改写旧文件。
- 估算 token 超预算（默认 10 万，`PCODE_CONTEXT_LIMIT` 可调）时，**先自动压缩**（把旧对话
  压成任务摘要，保留目标与未完成事项；`/compact` 可手动触发），失败再降级为裁剪
  （丢最旧的工具输出，替换为占位文本，最近 12 条不动，assistant↔tool 配对结构保持合法）。
- 指令注入：`~/.pcode/AGENTS.md`（全局）+ 项目根 `AGENTS.md`，按序拼进 system prompt。
- 429/5xx/网络错误指数退避重试（最多 3 次、1s/2s，仅首字节前）。

## 架构导览

五层结构 + 插件注册表（一切能力皆插件，自研零依赖内核）：

```
pcode/
├── kernel/          # 特权核心：definePlugin/注册表/App 装配/配置/共享工具
├── core/            # agent_loop、turn（一轮编排）、trim、session、permission、systemprompt
├── providers/       # openai / anthropic 客户端+插件，sse/retry 共用件
├── plugins/         # 工具与命令插件；__init__.py 是唯一清单（加插件=加文件+一行）
└── shell/           # repl 壳
```

- 加能力只写一个文件：活例是 `pcode/plugins/tools/todo.py`（任务清单），
  模板骨架见 `docs/guides/学习指南.md` 第六节。
- 分层铁律与 tcode 的文件级对应关系：[ARCHITECTURE.md](ARCHITECTURE.md)。
- 对话核心（provider/agent_loop）不依赖任何终端 API，换壳不动核心。

## 与 tcode 的已知差异

行为规格逐条对齐 tcode，仅两处刻意取舍：

1. **无 web 壳**：tcode 有 `tcode web` 浏览器版（本地 HTTP 服务 + SSE + 单文件 UI），
   pcode 只做 REPL 壳——同一内核将来可加并列的 web 壳，核心零改动。
2. **Ctrl+C 语义**：tcode 的 readline 能分场景路由 SIGINT（流式中=中止本轮、
   确认中=拒绝本次、空闲=退出）；Python 标准库同步模型没有可中断的流读取，
   轮中 Ctrl+C 直接退出进程（会话文件会先补齐断尾再退出，不会留下非法消息序列）。

另一条附带说明：tcode 文档写的"Ctrl+C 空闲=退出"，pcode 相同（空闲 Ctrl+C 退出）。

Windows 侧的取舍：REPL 用标准库 `input()`，**无历史记录**（上下键不翻历史）——
同步模型、零依赖下的有意取舍。

## 开发

```bash
python -m unittest discover -s test -v   # 单测（事件序列、compact、edit 唯一性、上下文裁剪、SSRF 判定表、注册表）
python test/smoke.py                     # 端到端冒烟：本地假 SSE 服务器，五场景，无网络依赖
```

## 验收（真实模型端到端）

与 tcode 相同：给它一个带 bug 的玩具项目，让它"跑测试 → read/edit 修复 → 复跑全绿"。
pcode 通过标准同 tcode README 的验收节，无人值守完成即验收通过。
