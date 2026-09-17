# pcode 架构

> 改 `pcode/` 之前先读这篇。目标：结构能从当前的千行级长到百万行级而不塌。
> 参照系是 `../tcode/`（同族 TypeScript 版）的 everything-is-a-plugin 内核，
> 行为规格以它为准——本文记录同一规格在 Python 里的表达。

## 一张图

```
__main__.py ──装配──▶ kernel ──▶ plugins（清单）──▶ shell(repl)
                      │             │
                      │             ├── tools/     八个内置工具 + rg/pathguard/netguard 共用件
                      │             ├── commands/  五条斜杠命令
                      │             └── (providers) anthropic / openai
                      ▼
                    core/  agent_loop · turn · trim · session · permission · systemprompt
```

依赖方向（只能向左/向下）：

```
kernel  ←  core  ←  providers / plugins/*  ←  shell  ←  __main__
```

- **kernel 不 import 任何其他层**（仅 `typing.TYPE_CHECKING` 下的纯类型引用）。
- core 不 import providers/plugins/shell；providers/plugins 不 import shell。
- 违反这条的改动直接打回，没有例外。这是百万行目标下唯一靠自觉守不住的东西。

## 五层的职责

| 层 | 目录 | 职责 | 现有文件 |
| --- | --- | --- | --- |
| kernel | `pcode/kernel/` | 插件 API、注册表、App 装配、配置、共享工具 | types/plugin/registry/app/config/ui |
| core | `pcode/core/` | agent loop、一轮编排、上下文裁剪、会话、权限、系统提示词 | agent_loop/turn/trim/session/permission/systemprompt |
| providers | `pcode/providers/` | 协议客户端 + provider 插件 | openai/anthropic/sse/retry |
| plugins | `pcode/plugins/` | 工具与命令插件 + 显式清单 | tools/×11（8 插件 + rg/pathguard/netguard 共用件） commands/×5 `__init__.py` |
| shell | `pcode/shell/` | 交互壳：repl（tui/单发/web 是未来的并列壳） | repl |

## 与 tcode 的文件级对应关系

| tcode | pcode | 说明 |
| --- | --- | --- |
| `src/kernel/types.ts` | `pcode/kernel/types.py` | 线格式类型：TypedDict(dataclass) 替代 interface |
| `src/kernel/plugin.ts` | `pcode/kernel/plugin.py` | `define_plugin` 恒等函数 + 四类 dataclass |
| `src/kernel/registry.ts` | `pcode/kernel/registry.py` | Registry 类 + 模块级 `to_schemas` |
| `src/kernel/app.ts` | `pcode/kernel/app.py` | App 类、`create_app`、`select_provider`、`VERSION` |
| `src/kernel/config.ts` | `pcode/kernel/config.py` | 环境变量 PCODE_* > `~/.pcode/config.json` > 报错 |
| `src/kernel/ui.ts` | `pcode/kernel/ui.py` | ANSI 着色（仅 TTY）+ `ellipsis` |
| `src/core/agentloop.ts` | `pcode/core/agent_loop.py` | 40 轮熔断、tool 消息回流 |
| `src/core/turn.ts` | `pcode/core/turn.py` | 裁剪→入列→循环→断尾修复→落盘 |
| `src/core/trim.ts` | `pcode/core/trim.py` | token 估算与裁剪（同一公式） |
| `src/core/session.ts` | `pcode/core/session.py` | JSONL 追加写 + 目录边界 |
| `src/core/permission.ts` | `pcode/core/permission.py` | 三态闸门（allow/deny/always） |
| `src/core/systemprompt.ts` | `pcode/core/systemprompt.py` | 身份 + AGENTS.md 注入 |
| `src/providers/{openai,anthropic,sse,retry}.ts` | `pcode/providers/` 同名 .py | 双协议 + SSE 手写解析 + 退避重试 |
| `src/plugins/tools/*.ts` | `pcode/plugins/tools/` 同名 .py | webfetch.ts → web_fetch.py（蛇形命名） |
| `src/plugins/commands/*.ts` | `pcode/plugins/commands/` 同名 .py | help/new/resume/yolo/exit |
| `src/plugins/index.ts` | `pcode/plugins/__init__.py` | 唯一清单，openai 兜底放最后 |
| `src/shell/repl.ts` | `pcode/shell/repl.py` | 壳只管路由；SIGINT 三态路由无（见 README 已知局限） |
| `src/main.ts` | `pcode/__main__.py` | argparse 装配入口 |
| `test/*.test.ts` + `test/smoke.mjs` | `test/test_*.py` + `test/smoke.py` | unittest + 本地假 SSE 冒烟 |

tcode 的 `src/shell/web.ts`、`desktop/`（Tauri 壳）**不移植**——pcode 只做 REPL 壳。

## 插件模型

四类插件，统一 `define_plugin({...})`，靠 `kind` 判别（dataclass 字段带默认值）：

| kind | 关键字段 | 现有插件 |
| --- | --- | --- |
| `tool` | description/parameters/needs_permission/preview/run | read write edit bash glob grep todo web_fetch |
| `command` | usage/summary/run(app,args)→CommandOutcome\|None | help new resume yolo exit |
| `provider` | matches(baseUrl)/create(config) | anthropic openai（兜底） |
| `shell` | start(app) | repl（web 是未来的并列壳） |

装配规则（`pcode/plugins/__init__.py` 是唯一清单）：

1. **显式清单，不扫目录**——加插件 = 加文件 + 清单一行，装配顺序可读可预测。
2. provider 按注册顺序取首个 `matches` 命中者；`openai` 恒真，必须放最后。
3. 运行环境通过 `App` 注入（config/registry/provider/store/yolo/messages +
   start_session/reset_messages），插件之间互不 import，全部找 App 要。

## 什么在 core、什么进注册表（与 tcode 的 Q4 决策一致）

- **插件化**：tool / provider / command / shell——高频扩展面。
- **留在 core**：agent_loop（灵魂考点，插件化它的收益是给生态换驱动，现在没有）、
  permission（安全边界不开放替换）、trim / session / systemprompt（同属核心语义）。
- 它们仍是接口化可替换的（如 permission 的 PermissionIO 注入），只是不进注册表。

## 同一规格的 Python 表达（与 tcode 的刻意差异）

| 主题 | tcode（TS） | pcode（Python） | 为什么 |
| --- | --- | --- | --- |
| 并发模型 | async/await + fetch 流 | 同步阻塞 + urllib，`read1` 逐块读 | 规格要求：教学清晰优先 |
| 用户中止 | AbortSignal + AbortError | KeyboardInterrupt（同步天然的等价物） | retry 绝不重试它 |
| SSE | ReadableStream + TextDecoder | `http.client.HTTPResponse` 逐行迭代 | 同一事件边界语义 |
| 重试 | TypeError=网络错误 | `URLError`/`OSError`（HTTPError 除外） | Python 的异常层级 |
| IPv6 判定 | 手写正则（只认缩写形式） | `ipaddress` 标准库 | 展开形式（`0:0:0:0:0:0:0:1`）天然覆盖 |
| 子进程输出 | data 事件里封顶累积 | 后台线程封顶泵 + `wait(timeout)` | 避免双管道死锁与失控输出 |
| web 壳 | 本地 HTTP 服务 + SSE + 安全闸 | 不移植 | 只做 REPL，内核随时可加并列壳 |
| Ctrl+C | readline SIGINT 三态路由 | 退出进程（退出前补齐断尾） | 同步模型无不可中断流读取 |
