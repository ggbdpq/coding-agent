// SC-007：截断参数——finish_reason 为截断（length）时，参数必须按截断处理：不执行工具、
// 回灌含工具名与原始参数的固定话术。期望值来源：agent-loop.md 修订草案 R3 六出口 +
// provider.md 修订草案（finishReason 归一化映射：length=截断）+ 05-风险 R5（截断的参数
// 不执行，防止写入半截内容）。
// 与 SC-006 的唯一差异在剧本：finish_reason 覆盖为截断值（raw_arguments 由截断产生非法 JSON）。
// 分类（截断 vs 参数非法）经 tool_error 事件的 kind 字段区分，S3 通道尚无规范锁定的渲染文本，
// 故本场景锚定与 SC-006 相同的可观测后果（R-schema-2：不锚实现渲染）。
export default {
  id: "SC-007",
  title: "截断参数——按截断分类处理：工具不执行且回灌固定话术",
  purpose: "验证 finish_reason=截断时不执行工具、fixture 不变、tool 消息携带工具名与原始参数片段",
  related_specs: [
    "agent-loop.md#R3 修订草案（第六出口：参数非法）",
    "provider.md#finishReason 归一化映射（length=截断）",
    "05-风险与不确定点.md#R5（截断参数不执行）",
  ],
  maturity: "draft", // ADR-003 TS 先行：非参考实现差异按 normalization-policy E9 判 ALLOW_DIFF（复查 2026-11-18）
  coverage: "all",
  input: {
    entry: "exec",
    approval: "yolo",
    protocol: "openai",
    task: "把内容写入 notes/trunc.txt",
    fixtures: { "notes/trunc.txt": "original\n" },
    model_script: {
      kind: "steps",
      steps: [
        {
          tool_call: {
            name: "write",
            raw_arguments: '{"file_path": "notes/trunc.txt", "content": "export const broken',
          },
          finish_reason: "length", // 覆盖缺省 tool_calls：截断结束原因
        },
        { text: "参数被截断，请重新给出完整参数。TRUNC-REJECTED-7b3" },
      ],
    },
  },
  expect: {
    verdict: { level: "ok", exit: 0 },
    provider_requests: {
      count: 2,
      items: [
        {
          nth: 2,
          last_tool_message_includes: ["write", "export const broken"],
        },
      ],
    },
    artifacts: { "notes/trunc.txt": "unchanged" }, // 截断参数不得落盘半截内容
  },
};
