# ARCHITECTURE —— 结构一页图

一句话：同一 coding agent 的五语言实现家族。**根层是共享契约层，`impls/` 收口实现**；
行为规格以 `specs/` 为最高裁决，tcode 是参考实现而非规范。

结构来源（双参照）：根层组织学 `gh/language` monorepo（契约三件套 + impls 收口 +
裁决链成文）；实现内部取向学 `apache/maka`（语义层不持进程/网络权威、管/不管分界、
fake 即公共 API）。研究记录见 [docs/ZCode学习笔记.md](docs/ZCode学习笔记.md)。

## 目录分层

```text
根层 = 共享层                    impls/<lang>/ = 实现层（五版同构）
├── ARCHITECTURE.md  本文件      ├── kernel/    契约词汇（零依赖）
├── specs/           行为规格    ├── core/      语义层
├── impls/           五实现      ├── providers/ 网络 IO（双协议 + 重试）
├── docs/            手册/ADR    ├── plugins/   工具与命令（fs/执行 IO）
└── references/      历史存档    └── shell/     装配与呈现（进程权威）
```

## 裁决链

**specs/ → impls/typescript 源码（参考实现）→ docs 教程与笔记。**
"参考实现不是规范"：实现代码与 spec 冲突时按 [specs/README.md](specs/README.md)
写作约定 1 处理——要么改代码要么改规格，不允许规范与现实各说各话。
跨实现重大结构决策走 [docs/adr/](docs/adr/)。

## 每层管 / 不管（职责可证伪）

| 层 | 管 | 不管 |
| --- | --- | --- |
| `impls/<lang>/kernel` | 类型与线格式词汇 | 任何行为 |
| `impls/<lang>/core` | 循环/治理/权限/事件语义 | 网络、进程、装配 |
| `impls/<lang>/providers` | 网络 IO（协议/重试/SSE） | 业务语义 |
| `impls/<lang>/plugins` | 工具与命令（fs/执行） | 权限判定（归 core 闸门） |
| `impls/<lang>/shell` | 进程生命周期、装配、呈现 | 业务语义 |
| `specs/` | 行为规格与裁决 | 具体实现 |
| `docs/` | 手册、ADR、研究笔记 | 行为规格（规格只在 specs/） |

## 实现内部纪律（maka 取向，五版同构）

1. 语义层（core/）禁网络/进程 import；IO 权威收敛在 store/provider/tools/shell 边界。
2. kernel/types 是零依赖契约层——全家族共享词汇，无行为。
3. fake provider 是公共 API 的一部分：测试经注入运行，不 touch 真实 fs/网络/模型。
4. "一个会话被多个壳同时看到"需要唯一执行权威（maka 的 runtime-host 模式）——
   现为搁置候选（[docs/从零到一到一百.md](docs/从零到一到一百.md) §3.3），未启用前
   各壳单进程独占会话。

## 阅读路径

- 新读者：README → 本文件 → [specs/README.md](specs/README.md) → 感兴趣的 spec →
  `impls/typescript/`（准绳实现）。
- 新语言版：[docs/从零到一到一百.md](docs/从零到一到一百.md) §四操作手册，
  按本文件"实现内部纪律"起步。
- 结构变更：先写 [docs/adr/](docs/adr/)。
