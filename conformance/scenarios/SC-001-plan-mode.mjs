// SC-001：Plan Mode 拒写——yolo 下 Plan Mode 是写操作的唯一拦截闸门。
// 期望值来源：agent-loop.md#R6（拒写全文逐字锁定；判定次序先于执行/询问/事件/白名单）。
// 若拒写失效，yolo 会放行写入、fixture 被真改——artifacts 通道直接抓到（fail closed）。
const REFUSAL =
  "当前处于 Plan Mode（只读规划）：禁止执行写类操作。请继续只读探索，并输出一份分步计划；完成后告知用户用 /plan 切回普通模式执行。";

export default {
  id: "SC-001",
  title: "Plan Mode 拒写——yolo 下写操作唯一拦截是规划态",
  purpose: "验证 Agent 状态机：规划态下写类工具在执行/询问/事件之前被拒，拒写文本回流，产物零变更",
  related_specs: ["agent-loop.md#R6", "permission.md#R1（判定次序在闸门之前）"],
  maturity: "frozen", // 五版首跑 PASS（2026-10-01）+ 红操演练转红（临时注入拒写失效，见 docs/conformance-lessons.md）
  coverage: "all",
  input: {
    entry: "repl-script",
    approval: "yolo",
    protocol: "openai",
    task: "把执行计划写入 notes/plan-target.md",
    stdin: [
      { write: "/plan" },
      { write: "把执行计划写入 notes/plan-target.md" },
      { wait: "PLAN-FINAL-7d3a" },
      { write: "/exit" },
    ],
    fixtures: { "notes/plan-target.md": "original\n" },
    model_script: {
      kind: "tool-then-text",
      tool: { name: "write", arguments: { path: "notes/plan-target.md", content: "plan-draft\n" } },
      final_text: "已给出分步计划：PLAN-FINAL-7d3a。执行前请用 /plan 切回普通模式。",
    },
  },
  expect: {
    verdict: { level: "ok", exit: 0 },
    provider_requests: {
      count: 2,
      items: [{ nth: 2, last_tool_message_equals: REFUSAL }],
    },
    artifacts: { "notes/plan-target.md": "unchanged" },
  },
};
