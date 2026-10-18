// SC-009：轮次上限——工具往返上限可配置（本场景 maxToolRounds=2），到限后强制一次不带工具
// schema 的总结请求收尾。期望值来源：agent-loop.md 修订草案 R2（上限可配置 TurnDeps.maxRounds，
// 触发时先发 limit { kind, limit, behavior } 事件；总结请求不带工具 schema；TurnEndReason
// 仍为 completed，到限不是失败）。
// 剧本前两步各给一次工具调用——"模型一直要工具"在本场景视野内的等价形式；第三步是总结文本：
// 位置化回放下，只有"到限即收尾"的实现会在第 3 次请求收到总结步。现行固定 40 轮上限的实现
// 第 3 次请求仍携带 tools schema，has_tools=false 断言据此抓漂移。
// limit 事件尚无规范锁定的 stdout 渲染文本，故不锚 S3 文案（R-schema-2）；行为面由
// S1（末请求不带 tools）+ S2（正常收尾）锁定。
// max_tool_rounds 是场景级逻辑配置：各实现的可配置入口随对应工作包落地后由适配器映射；
// 当前各实现均按缺省上限运行——这正是本场景要抓的漂移。
export default {
  id: "SC-009",
  title: "轮次上限——到限强制总结且末次请求不带 tools",
  purpose: "验证工具往返上限可配置：配置 2 轮时第 3 次请求是不带工具 schema 的强制总结，进程正常收尾",
  related_specs: [
    "agent-loop.md#R2 修订草案（上限可配置 + limit 事件 + 强制总结不带工具）",
    "event.md#修订草案（limit 事件；TurnEndReason 不新增取值）",
  ],
  maturity: "draft", // ADR-003 TS 先行：非参考实现差异按 normalization-policy E9 判 ALLOW_DIFF（复查 2026-11-18）
  coverage: "all",
  input: {
    entry: "exec",
    approval: "yolo",
    protocol: "openai",
    task: "连续执行两轮工具调用",
    max_tool_rounds: 2, // 场景级逻辑配置；适配器映射随对应工作包的可配置入口落地
    model_script: {
      kind: "steps",
      steps: [
        { tool_call: { name: "bash", arguments: { command: "true" } } },
        { tool_call: { name: "bash", arguments: { command: "true" } } },
        { text: "已达到轮次上限，强制总结收尾。LIMIT-STOP-5c7" },
      ],
    },
  },
  expect: {
    verdict: { level: "ok", exit: 0 }, // 到限不是失败：强制总结后正常收尾
    provider_requests: {
      count: 3, // 2 轮工具往返 + 1 次强制总结
      items: [{ nth: 3, has_tools: false }], // 总结请求不带工具 schema
    },
  },
};
