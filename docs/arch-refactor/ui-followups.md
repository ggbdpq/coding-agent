# UI 跟进清单：新事件的 web 渲染（等 ui/refresh-workbench 合并后补）

> 背景见 03-并行开发计划 §5 硬约束：本轮重构冻结 `impls/typescript/src/shell/web.html`
>（UI 分支正在改它）。各工作包新增的事件渲染，repl 侧随包落地；web 侧统一登记在此，
> 待 UI 分支合并后由收尾批次补齐。每条注明：事件、期望渲染、来源 WP。

## 待补条目

## WP3（feat/wp3-toolargs）

- 事件：`tool_error { call_id, name, kind, detail }`
- 期望渲染：web 侧 renderLog 增加一个 `case 'tool_error'`，输出一行红色错误文案
  （形如 `✗ {name} 参数错误（{kind}）：{detail}`），只用现有 CSS 类，不加新布局。
- repl 侧已随包落地（`src/shell/repl.ts` renderToTerminal）。
- 来源：WP3 参数校验与结束原因（分支 feat/wp3-toolargs）。
- 状态：等待 UI 分支（ui/refresh-workbench）合并后补。

## WP4（feat/wp4-permission-scope）

- 事件：`permission` 载荷新增可选字段 `grantKey` / `grantLabel`（有键才带；
  复合 bash 命令等不可 scoped 的请求不带，字段缺省即原三档，向后兼容）。
- 期望渲染：审批卡片在带 `grantLabel` 时增加第四个按钮「s=<grantLabel>」
  （POST 决策值 `'scoped'`，后端 /permission 校验已接受），复用现有按钮样式；
  不带键的请求保持原三按钮。
- repl 侧已随包落地（`src/shell/repl.ts` 提示第四选项 `s=<grantLabel>`）。
- web.html 本轮冻结未改；`web.ts` 的回归由 test/web.test.mjs（scoped 决策
  HTTP 用例）覆盖，浏览器渲染验证待本条补齐时一并做。
- 来源：WP4 审批 scoped 第四态（分支 feat/wp4-permission-scope）。
- 状态：等待 UI 分支（ui/refresh-workbench）合并后补。

## WP5（feat/wp5-limits）

- 事件：`limit { kind:'model_calls'|'tool_calls', limit, behavior }`
- 期望渲染：web 侧 renderLog 增加一个 `case 'limit'`，输出一行灰字
  「已达工具轮次上限（40），正在总结」（数字取 `ev.limit`），只用现有 CSS 类，
  不加新布局。
- repl 侧已随包落地（`src/shell/repl.ts` renderToTerminal，一行 `c.yellow`）。
- 来源：WP5 轮次与调用上限（分支 feat/wp5-limits）。
- 状态：等待 UI 分支（ui/refresh-workbench）合并后补。
