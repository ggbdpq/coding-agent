# coding-agent · Specification-driven Coding Agent Runtime

**A specification-driven coding agent runtime with executable cross-language conformance verification.**
一个以行为规范驱动、并通过可执行一致性套件验证多语言实现一致性的 Coding Agent Runtime。

同一套 Agent 行为规范（specs/）在五种语言运行时（impls/）中实现，由可执行一致性套件
（conformance/）机器验证跨版等价。核心主张：**行为契约比任何一份实现都稳定**。

## What is this

- `specs/` 是唯一事实源（SSOT）：Agent Loop / Tool Protocol / Permission / Context /
  Provider / Event / Session 七篇行为规范，每篇含本质约束、语言中立规则与反例清单。
- `impls/` 是同一规范的五种语言表达：TypeScript / Python / Go / Rust / C#，
  全部对齐 v0.5.0 能力线（九工具、权限三态闸门、40 轮熔断、双协议、Plan Mode、
  apply_patch 原子补丁、统一事件模型）。
- `conformance/` 是规范的机器执行面：同一 scenario 驱动五个 runtime，归一化后跨版比对，
  输出 PASS / ALLOW_DIFF / DRIFT。

## Architecture

```text
Behavior Specification (specs/)
        ↓
Runtime Implementations (impls/ × 5)
        ↓
Executable Conformance (conformance/)
```

裁决链：**specs > conformance > tcode 源码（参考实现）> 教程与笔记**。
"参考实现不是规范"：期望值只取自 specs，禁止从任何实现的现行为抄录。

## Supported Runtime

| Runtime | 语言目录 | 依赖 | 入口 | 测试 |
| --- | --- | --- | --- | --- |
| tcode | `impls/typescript/` | 0 | `node bin/tcode.js` | `npm test` + `npm run smoke` |
| pcode | `impls/python/` | 0 | `python -m pcode` | `python -m unittest discover -s test` + `python test/smoke.py` |
| gcode | `impls/go/` | 0 | `go run ./cmd/gcode` | `go test ./...`（含冒烟） |
| rcode | `impls/rust/` | 2 | `cargo run` | `cargo test`（含冒烟） |
| ccode | `impls/csharp/` | 0 | `dotnet run` | `dotnet run --project tests` |

## Conformance Evidence

三条 Agent 生命周期边界，每条一个 frozen 场景，五 runtime 全绿（CI 自动验证）：

| Scenario | 边界 | 断言要点 |
| --- | --- | --- |
| SC-004 | **Input Boundary** | exec 缺 `--yolo` → 拒绝执行、零模型调用、stderr 指认旗标 |
| SC-001 | **Decision Boundary** | Plan Mode 下写类工具在执行/询问/事件之前被拒；拒写文案逐字一致（规范锁定）；产物零变更 |
| SC-002A | **Mutation Boundary** | 审批确认前不落盘；确认后多文件补丁字节级精确应用 |
| SC-002B | **Mutation Boundary** | 任一编辑预验失败 → 整体零写入（无半修改状态）+ 错误折叠回流 |

可验证执行链：每次运行输出构建新鲜度门（sha256 + 时间戳，防"单测绿/冒烟红"的陈旧产物
假象，见 [docs/conformance-lessons.md](docs/conformance-lessons.md) L1）；diff 采用
**fail closed**——不可归类的差异一律判漂移（[normalization policy](docs/conformance-normalization-policy.md)）；
每个场景冻结前必须通过**红操演练**（手工注入漂移，套件必须单点转红）。

## Design Principles

- **Spec first**：规范先于实现；实现与 spec 冲突时要么改代码要么改规范，不允许各说各话。
- **Fail closed**：一致性判定宁可红灯误报，不可绿灯假阳。
- **Implementation independent**：场景源零实现词（grep 门强制）——第六语言 = 一个 adapter，
  scenario 零改动。

## 快速开始

```bash
# 一致性套件（需 node 24 / python 3.12 / go / rust / dotnet 8）
node conformance/run.mjs all

# 单语言运行
node impls/typescript/bin/tcode.js          # 或 python -m pcode / go run ./cmd/gcode（impls/go）/ cargo run（impls/rust）/ dotnet run（impls/csharp）
```

无真实 API Key 时各版自动要求本地假端点；离线一致性验证全程使用脚本化假 provider，
不依赖任何真实模型。

## Limitations

- 不是生产 IDE 集成（无编辑器插件、无 LSP）；
- 不是自主部署方案（无沙箱隔离、无云端执行）；
- 平台允许偏差显式登记于 specs（如同步语言 Python/Rust 无轮中取消，Ctrl+C 退出进程）。

## 目录结构

```text
coding-agent/
├── ARCHITECTURE.md      # 结构一页图 + 裁决链 + 阅读路径
├── specs/               # 行为规范（SSOT，正文 v1）
├── conformance/         # 可执行一致性套件（scenario / adapter / normalizer / diff）
├── impls/               # 五语言实现
│   ├── typescript/      # tcode —— 参考实现（非规范）
│   ├── python/          # pcode
│   ├── go/              # gcode
│   ├── rust/            # rcode
│   └── csharp/          # ccode
├── docs/                # ADR、一致性审计/Schema/Policy/Risks/Lessons、路线图
└── references/history/  # 并仓前独立历史 git bundle 存档
```

## 共同约定（v0.5 能力线）

- 行为规格：九工具（read/write/edit/bash/glob/grep/todo/web_fetch/apply_patch，
  web_fetch 带 SSRF 三道闸）、权限三态闸门（allow/deny/always，`allowWriteDirs` 白名单内
  免确认）、40 轮熔断、双协议（OpenAI 兼容 + Anthropic，按 BASE_URL 含 `/anthropic` 识别）。
- 统一事件模型：AgentEvent（turn_start/user/text_delta/tool_call/tool_result/trimmed/
  usage/turn_end+终态原因），turn 唯一生产者，壳只订阅渲染。
- 上下文治理：估算超预算 80% 先 /compact（保留最近 4 条原文），仍超限退裁剪。
- Plan Mode：`/plan` 只读规划，写类工具在权限闸门之前被拒并引导产出计划。
- 无交互模式：`exec "任务"`（须 --yolo），退出码携带成败；@文件引用；审批策略
  normal|never。
- 配置目录各自独立（~/.tcode 等）；会话 JSONL schema 五版通用。
- 修 bug 请对照笔记查其余版本的对应模块——一份修，五份同步（conformance 会替你盯住）。
