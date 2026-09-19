# specs —— 跨语言统一设计规范

一句话：把"五版逐条对齐"的事实行为基线提炼成显式规范；新语言版按 specs 先行，
再对照 typescript 源码实现。

状态：**骨架**（2026-09-19 建）。本期只做两件事——钉死各主题的范围边界与权威出处；
规范正文未写，写作前事实准绳仍是各主题权威文件（下表）。

| 主题 | 范围（一句话） | 当前权威出处（typescript/） |
| --- | --- | --- |
| Agent Loop | 工具往返循环、40 轮熔断、错误文本回流、断尾修复、Plan Mode 拒写 | `src/core/agentloop.ts` |
| Tool Protocol | 工具契约：schema/preview/needsPermission/skipPermission/needsPermission 工具的确认语义 | `src/kernel/plugin.ts` |
| Session/Turn | 会话 JSONL schema（meta+message 行）、runUserTurn 编排、事件发射 | `src/core/session.ts`、`src/core/turn.ts` |
| Context | 轮前治理：估算 ceil(字符/3)+8、80% 触发 /compact（尾部保留）、超限退 trim | `src/core/compact.ts`、`src/core/trim.ts` |
| Permission | 三态闸门（allow/deny/always）、写白名单、审批策略 normal/never | `src/core/permission.ts` |
| Provider | 双协议自动识别（BASE_URL 含 /anthropic）、手写 SSE、重试仅首字节前 | `src/providers/` |
| Event | AgentEvent 判别联合、终态原因、usage 事件 | `src/kernel/types.ts` |

写作约定：

1. 动笔前先跑四兄弟版的对应模块 diff（对照笔记 `typescript/docs/notes/` 里有差异清单）；
   与 tcode 行为冲突的 spec 是坏 spec——要么改代码要么改规格，不允许规范与现实各说各话。
2. 冒烟场景（A/B/C/D/F/H）是这套规范的可用可执行面；spec 变更后五版冒烟必须全绿。
3. 一个主题一个文件（`agent-loop.md` 等），写完一个在索引表里把"权威出处"换成 spec 链接。
