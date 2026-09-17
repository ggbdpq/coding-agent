# gcode 架构

> 改 `src/` 之前先读这篇。目标：结构能从当前的千行级长到百万行级而不塌。
> 参照系是 [deepseek-harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的
> "everything-is-a-plugin"，但实现保持零依赖手写——抄思想，不抄框架。

## 一张图

```
main.ts ──装配──▶ kernel ──▶ plugins（清单）──▶ shell(repl)
                  │             │
                  │             ├── tools/     六个内置工具 + todo
                  │             ├── commands/  五条斜杠命令
                  │             └── (providers) anthropic / openai
                  ▼
                core/  agentloop · trim · session · permission · systemprompt
```

依赖方向（只能向左/向下）：

```
kernel  ←  core  ←  providers / plugins/*  ←  shell  ←  main
```

- **kernel 不 import 任何其他层**（类型除外时也不行——用结构化接口注入）。
- core 不 import providers/plugins/shell；providers/plugins 不 import shell。
- 违反这条的 PR 直接打回，没有例外。这是百万行目标下唯一靠自觉守不住的东西。

## 五层的职责

| 层 | 目录 | 职责 | 现有文件 |
| --- | --- | --- | --- |
| kernel | `src/kernel/` | 插件 API、注册表、App 装配、配置、共享工具 | plugin/registry/app/config/ui/types |
| core | `src/core/` | agent loop、上下文裁剪、会话、权限、系统提示词 | agentloop/trim/session/permission/systemprompt |
| providers | `src/providers/` | 协议客户端 + provider 插件 | openai/anthropic/sse/retry |
| plugins | `src/plugins/` | 工具与命令插件 + 显式清单 | tools/×10（8 插件 + rg/pathguard/netguard 共用件） commands/×5 index.ts |
| shell | `src/shell/` | 交互壳：repl（终端）、web（浏览器，本地服务+SSE） | repl / web |

> 另有 `desktop/`（Tauri 2 打包层）：把 web 壳包成原生窗体并托管后端进程，属于分发形态，不属于插件体系。

## 插件模型

四类插件，统一 `definePlugin({...})`，靠 `kind` 判别：

| kind | 关键字段 | 现有插件 |
| --- | --- | --- |
| `tool` | description/parameters/needsPermission/preview/run | read write edit bash glob grep todo web_fetch |
| `command` | usage/summary/run(app,args)→{exit?} | help new resume yolo exit |
| `provider` | matches(baseUrl)/create(config) | anthropic openai（兜底） |
| `shell` | start(app) | repl web（`gcode` 默认 repl，`gcode web` 起浏览器版） |

装配规则（`plugins/index.ts` 是唯一清单）：

1. **显式清单，不扫目录**——加插件 = 加文件 + 清单一行，装配顺序可读可预测。
   这也是 dsh 的取向（bundle/profile 都是显式组合）。
2. provider 按注册顺序取首个 `matches` 命中者；`openai` 恒真，必须放最后。
3. 运行环境通过 `App` 注入（config/registry/provider/store/yolo/messages +
   startSession/resetMessages），插件之间互不 import，全部找 App 要。

## 什么在 core、什么进注册表（Q4 决策）

- **插件化**：tool / provider / command / shell——高频扩展面。
- **留在 core**：agentloop（灵魂考点，插件化它的收益是给生态换驱动，现在没有）、
  permission（安全边界不开放替换）、trim / session / systemprompt（同属核心语义）。
- 它们仍是接口化可替换的（如 permission 的 IO 注入），只是不进注册表。

## 从 dsh 借了什么、没借什么

| 借 | 不借（及原因） |
| --- | --- |
| "没有特权核心"的思想 | Cordis 框架本体——重依赖违背零依赖手写哲学，且其 developer preview 破坏性变更频繁 |
| 一切能力皆插件 | pnpm workspace 分包——万行以内是纯税 |
| 显式组合（清单≈bundle） | profile/patch 热加载组合层——多运行形态（web/headless/sdk）出现才需要 |
| 日期命名的架构决策笔记（docs/notes/） | web/desktop/sdk 多端 |
| 每扩展面一页模板文档（docs/plugin-template.md） | 插件市场/生态运营 |

## 百万行路线图

| 阶段 | 触发条件 | 动作 |
| --- | --- | --- |
| 现在：单包分层 | — | 本文所述结构，零构建直跑 |
| 中期：分包 | 单包 >1 万行或出现明确子系统边界（如独立 TUI） | kernel/core 拆 `packages/core`，shell 与插件拆包，pnpm workspace |
| 远期：平台 | 有第三方写插件的真实需求 | 插件外置（npm 包/目录加载 + 契约校验）、profile 组合层、版本化插件 API |

## 决策记录

见 `docs/notes/`——每个影响结构的决策一篇，日期命名，只增不改。
