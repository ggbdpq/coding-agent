# specs —— 跨语言统一设计规范

一句话：把"五版逐条对齐"的事实行为基线提炼成显式规范；新语言版按 specs 先行，
再对照 typescript 源码实现。

状态：**正文 v1**（2026-09-27）。七篇规范正文全部完成——下表"权威出处"列已换成
spec 链接，原始权威文件保留在各 spec 头部。写作纪律见
**[methodology.md](methodology.md)**：每篇过五件工具流水线（蒸馏 → 第一性原理 →
高内聚低耦合 → 奥卡姆剃刀 → 对抗式审查），五版分歧按写作约定 1 裁决——
要么改代码要么改规格，不允许规范与现实各说各话。

写作方法论：**[methodology.md](methodology.md)** —— 五件思维工具（蒸馏 / 第一性原理 /
高内聚低耦合 / 奥卡姆剃刀 / 对抗式审查）、淘汰记录与证据边界；动笔前先读。

裁决链：**specs > tcode 源码（参考实现）> 教程与笔记**——"参考实现不是规范"，
实现与 spec 冲突按写作约定 1 处理；跨实现结构决策走 docs/adr/（见 ARCHITECTURE.md）。

| 主题 | 范围（一句话） | 当前权威出处（impls/typescript/） |
| --- | --- | --- |
| Agent Loop | 工具往返循环、40 轮熔断、错误文本回流、断尾修复、Plan Mode 拒写 | **[agent-loop.md](agent-loop.md)**（正文 v1，2026-09-27） |
| Tool Protocol | 工具契约：schema/preview/needsPermission/skipPermission/needsPermission 工具的确认语义 | **[tool-protocol.md](tool-protocol.md)**（正文 v1，2026-09-27） |
| Session/Turn | 会话 JSONL schema（meta+message 行）、runUserTurn 编排、事件发射 | **[session-turn.md](session-turn.md)**（正文 v1，2026-09-27） |
| Context | 轮前治理：估算 ceil(字符/3)+8、80% 触发 /compact（尾部保留）、超限退 trim | **[context.md](context.md)**（正文 v1，2026-09-27） |
| Permission | 三态闸门（allow/deny/always）、写白名单、审批策略 normal/never | **[permission.md](permission.md)**（正文 v1，2026-09-27） |
| Provider | 双协议自动识别（BASE_URL 含 /anthropic）、手写 SSE、重试仅首字节前 | **[provider.md](provider.md)**（正文 v1，2026-09-27） |
| Event | AgentEvent 判别联合、终态原因、usage 事件 | **[event.md](event.md)**（正文 v1，2026-09-27） |

写作约定：

1. 动笔前先跑四兄弟版的对应模块 diff（对照笔记 `impls/typescript/docs/notes/` 里有差异清单）；
   与 tcode 行为冲突的 spec 是坏 spec——要么改代码要么改规格，不允许规范与现实各说各话。
2. 冒烟场景（A/B/C/D/F/H）是这套规范的可用可执行面；spec 变更后五版冒烟必须全绿。
3. 一个主题一个文件（`agent-loop.md` 等），写完一个在索引表里把"权威出处"换成 spec 链接。
