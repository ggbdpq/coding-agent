# 2026-09-17 插件内核与五层结构

## 背景

gcode 功能稳定（冒烟 A/B/C + 真机验收通过），但装配关系藏在代码里：
repl 直接 import 六个工具、factory 硬编码两个 provider。用户目标是把 gcode
长成**百万行级**的庞然大物，且"一切都是插件"；参照 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。

## 决策（六问六答）

1. **形态**：单包分层起步（a），路线图画到平台/生态；workspace 在万行前是纯税。
2. **实现**：自研轻量内核（definePlugin + Registry + App），**不上 Cordis**——
   重依赖违背零依赖手写哲学；dsh 本人也处在 developer preview 破坏性变更期。
3. **目录**：kernel / core / providers / plugins / shell 五层 + main 装配。
4. **插件化范围**：tool/provider/command/shell 四类进注册表；
   agentloop、permission、trim、session、systemprompt 留 core——loop 是灵魂考点，
   permission 是安全边界，均不开放替换，但保持接口化。
5. **API**：统一 `definePlugin({ name, kind, ... })`，显式清单（`plugins/index.ts`）
   而非目录扫描——对齐 dsh 的 bundle/profile 显式组合取向。
6. **节奏**：重构零行为变化，tsc + 单测 + 冒烟 A/B/C 全绿为硬验收；
   外加 todo 演示插件（40 行）作为插件 API 的活样例。

## 层级铁律

```
kernel ← core ← providers/plugins ← shell ← main
```

kernel 不 import 其他任何层；被依赖的核心能力（store、freshMessages）以
结构化接口从 main 注入。违反即打回。

## 过程记录

- 阶段1（c57f991）：五层就位 + provider 插件化（matches 驱动选择，openai 兜底最后）。
- 阶段2（07bb42c）：五条命令插件化，/help 改为注册表自动生成，repl 只剩查表路由。
  途中 Mimosa 钩子把 `exec` 标识符误判为命令注入（这些文件零进程执行），
  接口动词改为 `run`（与 ToolPlugin 一致），顺带消除了命名歧义。
- 阶段3：todo 插件 + ARCHITECTURE.md + plugin-template.md + 本笔记 + README 更新。

## 备选与放弃

- **Cordis 本尊**：服务注入/生命周期/可逆 effect 白嫖最省事，但"从零理解"变
  "学会用它"；等插件外置（远期）再评估接入边界。
- **目录扫描自动发现插件**：少一行清单维护，但启动顺序不可预测、Windows 路径
  动态 import 脆弱、tsc 静态检查失效。显式清单的"一行成本"买确定性，值。
- **命令 exec 命名**：语义更贴切，但与 shell 执行词汇撞车（也是扫描器误报源），弃。
