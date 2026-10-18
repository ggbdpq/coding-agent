# UI 跟进清单：新事件的 web 渲染（等 ui/refresh-workbench 合并后补）

> 背景见 03-并行开发计划 §5 硬约束：本轮重构冻结 `impls/typescript/src/shell/web.html`
>（UI 分支正在改它）。各工作包新增的事件渲染，repl 侧随包落地；web 侧统一登记在此，
> 待 UI 分支合并后由收尾批次补齐。每条注明：事件、期望渲染、来源 WP。

## 待补条目

（各 WP 在此追加）

## WP3（feat/wp3-toolargs）

- 事件：`tool_error { call_id, name, kind, detail }`
- 期望渲染：web 侧 renderLog 增加一个 `case 'tool_error'`，输出一行红色错误文案
  （形如 `✗ {name} 参数错误（{kind}）：{detail}`），只用现有 CSS 类，不加新布局。
- repl 侧已随包落地（`src/shell/repl.ts` renderToTerminal）。
- 来源：WP3 参数校验与结束原因（分支 feat/wp3-toolargs）。
- 状态：等待 UI 分支（ui/refresh-workbench）合并后补。
