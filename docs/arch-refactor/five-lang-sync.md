# 五语言同步清单（ADR-003：TS 参考实现先行）

> 依据 04-测试与验收 §5：本轮只改 TypeScript 版；每个 WP 合并时在此追加一行
> （规则编号、TS 提交、其他四版状态）。场景级差异由 conformance 的 E 条目
> （ALLOW_DIFF）登记，规则级漂移登记在此，收尾批次排期移植。

## 待同步规则

| 规则编号 | 规则摘要 | TS 提交/分支 | 四版状态 | 登记来源 |
|---|---|---|---|---|
| permission R2/R3b | scoped 第四态（"本会话允许此类"）：进程内 Set<grantKey> 会话记忆；复合 shell 命令不可 scoped | feat/wp4-permission-scope | 四版待同步 | WP4 |
| session-turn | 落盘时机+加载断尾修复 | feat/wp6-incremental-persist | 四版待同步 | WP6 |
| event R8 | 断尾占位文案家族统一（ts 长文案为登记偏差，待收敛） | 集成分支 | ts 欠家族文本、rs 已登记、四版待核对 | WP6 合并时裁定 |
| agent-loop R9 | 中间件管线：planMode → 用户中间件 → permission（固定最内层，注册时断言）+ beforeModel/afterModel/wrapToolCall 洋葱 | feat/wp1-middleware | 四版待同步 | WP1 |
| context 触发点+摘要输入 | 治理挂轮前+每次模型调用前（清理→压缩→裁剪，压缩摘要输入含工具名/参数 200/结果 300） | feat/wp2-midturn-governance | 四版待同步 | WP2 |
