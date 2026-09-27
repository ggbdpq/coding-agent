# gcode 架构

> 改 `internal/` 之前先读这篇。目标：结构能从当前的千行级长到百万行级而不塌。
> 参照系是 "everything-is-a-plugin"（tcode 同源，源头是 deepseek-harness/dsh 的思想），
> 但实现保持零依赖手写——抄思想，不抄框架。

## 一张图

```
cmd/gcode ──装配──▶ kernel ──▶ plugins（清单）──▶ shell(repl)
                      │             │
                      │             ├── tools/     八个内置工具 + rg/pathguard/netguard 共用件
                      │             ├── commands/  五条斜杠命令
                      │             └── providers   anthropic / openai
                      ▼
                    core/  agentloop · turn · trim · session · permission · systemprompt
```

依赖方向（只能向左/向下）：

```
kernel  ←  core  ←  providers / plugins/*  ←  shell  ←  cmd/gcode
```

- **kernel 不 import 任何其他 internal 包**（跨层类型用结构化接口注入，如 `SessionStoreLike`）。
- core 不 import providers/plugins/shell；providers/plugins 不 import core 之外的壳。
- 违反这条的 PR 直接打回，没有例外。这是百万行目标下唯一靠自觉守不住的东西。

## 五层的职责

| 层 | 目录 | 职责 | 现有文件 |
| --- | --- | --- | --- |
| kernel | `internal/kernel/` | 插件类型+注册表、App 装配、配置、共享工具 | plugin/types/app/config/ui |
| core | `internal/core/` | agent loop、一轮编排、上下文裁剪、会话、权限、系统提示词 | agentloop/turn/trim/session/permission/systemprompt |
| providers | `internal/providers/` | 协议客户端 + provider 插件 | openai/anthropic/sse/retry |
| plugins | `internal/plugins/` | 工具与命令插件 + 显式清单 | tools/×11（8 插件 + rg/pathguard/netguard/args） commands/×5 plugins.go |
| shell | `internal/shell/` | 交互壳：repl（终端） | repl |

## 插件模型

四类插件，统一 `kernel.Plugin` 值（恰好一个字段非 nil，kind 判别）：

| kind | 关键字段 | 现有插件 |
| --- | --- | --- |
| tool | Description/Parameters/NeedsPermission/Preview/Run | read write edit bash glob grep todo web_fetch |
| command | Usage/Summary/Run(app,args)→{Exit?} | help new resume yolo exit |
| provider | Matches(baseUrl)/Create(config) | anthropic openai（兜底） |
| shell | Start(app) | repl |

装配规则（`internal/plugins/plugins.go` 是唯一清单）：

1. **显式清单，不扫目录**——加插件 = 加文件 + 清单一行，装配顺序可读可预测。
2. provider 按注册顺序取首个 `Matches` 命中者；`openai` 恒真，必须放最后。
3. 运行环境通过 `*kernel.App` 注入（Config/Registry/Provider/Store/Yolo/Messages +
   StartSession/ResetMessages），插件之间互不 import，全部找 App 要。
4. Go 与 TS 的表达差异：TS 用 `definePlugin` 恒等函数做类型推导；Go 用"恰好一个字段非 nil"
   的 Plugin 值 + `kind()`/`name()` 判别，`Register` 在同 kind 重名时返回错误（测试锁死）。

## 什么在 core、什么进注册表（对齐 tcode Q4 决策）

- **插件化**：tool / provider / command / shell——高频扩展面。
- **留在 core**：agentloop（灵魂考点）、permission（安全边界不开放替换，但 IO 接口化注入）、
  trim / session / systemprompt / turn（同属核心语义）。它们不进注册表。
- 同步阻塞模型：goroutine 只用于 stderr 收集、输出封顶拷贝这类小活；
  用户中止的 context 取消只在重试层生效（v1 轮中 Ctrl+C 直接退出进程，见 README 已知局限）。

## 测试布局

Go 惯例：单测与被测同目录。

| 测试 | 位置 | 锁什么 |
| --- | --- | --- |
| ApplyEdit 判定表 | `internal/plugins/tools/edit_test.go` | old_string 唯一性防线 |
| Trim 估算与裁剪 | `internal/core/trim_test.go` | 裁旧留新 12、配对完整、幂等 |
| Netguard 判定表 | `internal/plugins/tools/netguard_test.go` | SSRF 防线（含 IPv6 展开形式、::ffff: 映射） |
| Registry | `internal/kernel/registry_test.go` | 注册/按类取用/重名拒绝/schema 形状 |
| 端到端冒烟 | `internal/smoke/smoke_test.go` | 假 SSE 服务器 + 真二进制子进程，A/B/C/D/F 五场景 |

## 从百万行视角看

| 阶段 | 触发条件 | 动作 |
| --- | --- | --- |
| 现在：单模块分层 | — | 本文所述结构，零依赖 |
| 中期：拆包 | 单包 >1 万行或出现独立 TUI | internal/* 升级为独立 go module |
| 远期：平台 | 第三方写插件的真实需求 | 插件外置（目录加载 + 契约校验）、版本化插件 API |
