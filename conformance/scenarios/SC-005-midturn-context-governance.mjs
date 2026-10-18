// SC-005：轮内上下文治理——治理触发点必须在"每次模型调用前"，而不是只有轮前。
// 期望值来源：context.md 本质约束 1（超限前必须治理——治理是请求能发出的前提）+ R1（估算口径：
// 每条消息 content+8、每个 tool_call 另计 name+arguments+8，总和÷3 向上取整，全部消息含 system）
// + 修订草案（触发点=轮前+每次模型调用前；策略顺序=清理旧工具输出（保留最近 3 条）→压缩→裁剪，
// 零成本优先）。剧本让单轮连读 60KB 夹具 8 次：按"轮前才治理"的旧触发点，请求峰值估算
// ≈ 160k tokens 击穿任何合理上限；按修订草案，零成本的清理旧工具输出即可回到预算内，
// 不产生摘要调用，剧本序号不漂移。夹具纯 ASCII——五版字符计数口径（UTF-16/码点）无分歧。
// 治理事件（context_edit/compact/trimmed）无规范锁定的 stdout 渲染文本，故本场景以 S1 估算
// 上限为锚，不锚 stdout 文案（R-schema-2：期望值只能取自 specs）。
const LINE = `${"x".repeat(63)}\n`;
const BIG = LINE.repeat(960); // 960 行 × 64 字符 = 61440 字符（60KB）

export default {
  id: "SC-005",
  title: "轮内上下文治理——每次模型调用前估算不超预算",
  purpose: "验证治理触发点覆盖轮内：连读大文件时每个 provider 请求体估算都 ≤ 配置上限",
  related_specs: [
    "context.md#本质约束1（超限前必须治理）",
    "context.md#R1（估算口径）",
    "context.md#修订草案（触发点=轮前+每次模型调用前；清理旧工具输出→压缩→裁剪）",
  ],
  maturity: "draft", // ADR-003 TS 先行：非参考实现差异按 normalization-policy E9 判 ALLOW_DIFF（复查 2026-11-18）
  coverage: "all",
  input: {
    entry: "exec",
    approval: "yolo",
    protocol: "openai",
    task: "阅读 notes/big.txt 并概述内容",
    context_limit: 100000, // 场景级逻辑配置（显式声明，不依赖缺省值）；适配器映射为各实现的环境变量
    fixtures: { "notes/big.txt": BIG },
    model_script: {
      kind: "steps", // 第 N 次请求回放 steps[N-1]
      steps: [
        ...Array.from({ length: 8 }, () => ({
          tool_call: { name: "read", arguments: { file_path: "notes/big.txt" } },
        })),
        { text: "已读完并概述完毕：CONTEXT-OK-5e1" },
      ],
    },
  },
  expect: {
    verdict: { level: "ok", exit: 0 },
    provider_requests: {
      min_count: 9, // 8 次读 + 1 次收尾；零成本清理足够时不产生额外摘要调用（修订草案策略顺序）
      estimate_limit_tokens: 100000, // 每个请求体按 R1 口径估算 ≤ 上限
    },
    artifacts: { "notes/big.txt": "unchanged" },
  },
};
