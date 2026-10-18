// SC-006：非法工具参数——参数 JSON 非法时工具必须"不执行"，并回灌含工具名与原始参数的固定话术。
// 期望值来源：agent-loop.md 修订草案 R3 六出口（新增"参数非法"：不执行工具，回灌固定话术，
// 话术含工具名、原始参数前 200 字符、必需字段列表）+ R4 修订草案（废止"非法 JSON 静默降级
// 为空参数"）+ event.md 修订草案（tool_error 事件）。工具名与原始参数片段属于草案明文的
// 话术构成要素，故可作包含断言锚点；话术完整措辞未定稿，不做逐字断言。
// 现行"静默降级为 {}"的实现下，工具只会回「错误：缺少 file_path」类文案——既不含工具名
// 也不含原始参数片段，本场景据此抓漂移。
export default {
  id: "SC-006",
  title: "非法工具参数——工具不执行且回灌含工具名与原始参数的固定话术",
  purpose: "验证参数 JSON 非法时废止静默降级：工具零执行、fixture 不变、tool 消息携带工具名与原始参数",
  related_specs: [
    "agent-loop.md#R3 修订草案（第六出口：参数非法）",
    "agent-loop.md#R4 修订草案（废止静默降级）",
  ],
  maturity: "draft", // ADR-003 TS 先行：非参考实现差异按 normalization-policy E9 判 ALLOW_DIFF（复查 2026-11-18）
  coverage: "all",
  input: {
    entry: "exec",
    approval: "yolo",
    protocol: "openai",
    task: "把内容写入 notes/evil.txt",
    fixtures: { "notes/evil.txt": "original\n" },
    model_script: {
      kind: "steps",
      steps: [
        {
          tool_call: {
            name: "write",
            raw_arguments: '{"file_path": "notes/evil.txt", "content": "HACKED-NOT-WRITTEN"',
          },
        },
        { text: "参数有问题，请修正后重试。ARGS-REJECTED-9f2" },
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
          last_tool_message_includes: ["write", "HACKED-NOT-WRITTEN"], // 话术含工具名与原始参数（草案明文）
        },
      ],
    },
    artifacts: { "notes/evil.txt": "unchanged" }, // 工具未执行的核心证据
  },
};
