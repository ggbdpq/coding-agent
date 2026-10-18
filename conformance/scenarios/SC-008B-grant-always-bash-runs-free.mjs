// SC-008 臂 B：always 语义不变——对 write 回答 a（本会话全部允许）后，bash 不再询问、直接执行。
// 期望值来源：permission.md R3（always = 置会话级 yolo 布尔：进程内、不持久化、全局粒度，
// 不分工具/参数）。ADR-003 决策 5 明确"R3 的 always 语义不变"——本臂是 R3 的回归锁：
// scoped 增量不得把 always 改成按工具分粒度。若 always 被错误降级为按工具记忆，bash 会
// 重新询问并卡住收尾标记（超时），同样构成红灯。
const steps = [
  { tool_call: { name: "write", arguments: { file_path: "notes/write-target.txt", content: "written-by-model\n" } } },
  { tool_call: { name: "bash", arguments: { command: "cp notes/bash-src.txt notes/bash-target.txt" } } },
  { text: "两步都完成了。GRANT-FLOW-4e9" },
];

export default {
  id: "SC-008B",
  title: "授权粒度——write 选 always 后 bash 不再询问（R3 回归锁）",
  purpose: "验证 always 仍是会话级全局放行：write 的 always 记忆直接放行后续 bash，不再询问",
  related_specs: [
    "permission.md#R3（always = 会话级 yolo，全局粒度）",
    "permission.md#R2（三态映射：a → always）",
  ],
  maturity: "draft", // R3 是五版锁定契约，本臂各版都应 PASS；若漂移即 scoped 增量污染了 always 语义
  coverage: "all",
  input: {
    entry: "repl-script",
    approval: "interactive",
    protocol: "openai",
    task: "先写文件再拷贝一份",
    stdin: [
      { write: "先写文件再拷贝一份" },
      { wait: "write 请求执行" },
      { write: "a" }, // always：会话级全局放行
      { wait: "GRANT-FLOW-4e9" },
      { write: "/exit" },
    ],
    fixtures: {
      "notes/write-target.txt": "original\n",
      "notes/bash-src.txt": "bash-ran-4e9\n",
      "notes/bash-target.txt": "absent-marker\n",
    },
    model_script: { kind: "steps", steps },
  },
  expect: {
    verdict: { level: "ok", exit: 0 },
    provider_requests: { count: 3 },
    stdout_markers: {
      max_count: { "允许?": 1 }, // 仅 write 询问过一次；bash 不再询问
    },
    artifacts: {
      "notes/write-target.txt": "written-by-model\n",
      "notes/bash-target.txt": "bash-ran-4e9\n", // bash 未再询问、直接执行
    },
  },
};
