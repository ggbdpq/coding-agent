// SC-004 臂 A：exec 契约——缺 --yolo 必须拒绝执行，且零模型调用。
// 期望值来源：五版入口契约（exec 退出码语义经 ADR-002 升格为被锁定公共接口）；
// 锁定级别 = 退出码 1 + 零 provider 请求 + stderr 指认 --yolo + 无工具执行标记。
export default {
  id: "SC-004-A",
  title: "exec 缺 --yolo → invalid_input（拒绝执行、零模型调用）",
  purpose: "验证 CLI 契约边界：无审批声明时无交互模式必须拒绝，且不产生任何模型请求",
  related_specs: [
    "conformance-schema.md#SC-004",
    "ADR-002（exec 退出码语义 = 被锁定公共接口）",
  ],
  maturity: "draft",
  coverage: "all",
  input: {
    entry: "exec",
    task: "输出今日状态摘要",
    approval: null, // 关键：不给 --yolo
    protocol: "openai",
    model_script: [], // 期望零模型调用
  },
  expect: {
    verdict: { level: "invalid_input", exit: 1 },
    provider_requests: { count: 0 },
    stderr_markers: { includes: ["--yolo"] },
    stdout_markers: { absent: ["[tool]"] },
    artifacts: [],
  },
};
