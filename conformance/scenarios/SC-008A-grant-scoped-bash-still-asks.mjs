// SC-008 臂 A：授权粒度——对 bash 回答 s（scoped，"本会话允许此类"）后，write 必须仍然询问。
// 期望值来源：permission.md 修订草案 R2 四态（新增 s；y/n/a 含义不变）+ R3b（scoped 记忆 =
// 进程内按授权键的 Set，bash 返回 bash:<命令首词>；复合命令不可 scoped）+ R3（always 语义
// 不变，scoped 不得等价于会话级 yolo）+ R7（询问 UI 家族锁定文案）。
// 判定设计（04 §3 原文以 write 为 s 的对象、bash 仍询问；此处两工具互换等价验证同一语义：
// scoped 只记住本授权键，另一工具必须重新逐次询问——互为镜像，且 bash 放前面可让 "s" 落在
// bash 的询问上）：
// - bash 命令选 cp（单一首词、无重定向/管道等复合记号）——按 R3b 属于可提供 scoped 的命令；
// - 剧本顺序 bash → write：scoped 生效的实现里 "s" 是 bash 的合法答复、bash 直接执行；
//   未生效的实现把 "s" 当无效回答重复询问（"请回答" 标记出现）——该分支只在后者存在，
//   用带期限的条件应答步喂 "y"（生效实现超时跳过，不多消耗输入行）；
// - 区分观测（S3 次数断言）：家族锁定的询问行（"允许?"）恰好 2 次（bash + write 各一次）；
//   重复询问的实现是 3 次；
// - 产物断言：bash-target（cp 落盘）与 write-target 均按剧本落盘（放行路径都完成两个工具）。
// 请求计数 3 = 两次工具往返 + 一次收尾；stdin 恒以 /exit 干净收尾。
const steps = [
  { tool_call: { name: "bash", arguments: { command: "cp notes/bash-src.txt notes/bash-target.txt" } } },
  { tool_call: { name: "write", arguments: { file_path: "notes/write-target.txt", content: "written-by-model\n" } } },
  { text: "两步都完成了。GRANT-FLOW-4e9" },
];

export default {
  id: "SC-008A",
  title: "授权粒度——bash 选 scoped 后 write 仍询问",
  purpose: "验证 scoped 记忆按授权键生效：bash 的 scoped 授权不得放行 write，write 仍走逐次询问",
  related_specs: [
    "permission.md#R2 修订草案（四态：新增 s）",
    "permission.md#R3b 修订草案（scoped 按授权键记忆；复合命令不可 scoped）",
    "permission.md#R3（always 语义不变，scoped 非全局放行）",
    "permission.md#R7（询问 UI 家族锁定文案）",
  ],
  maturity: "draft", // ADR-003 TS 先行：非参考实现差异按 normalization-policy E9 判 ALLOW_DIFF（复查 2026-11-18）
  coverage: "all",
  input: {
    entry: "repl-script",
    approval: "interactive",
    protocol: "openai",
    task: "先拷贝一份再写文件",
    stdin: [
      { write: "先拷贝一份再写文件" },
      { wait: "bash 请求执行" }, // 询问 UI 的工具名标头（家族锁定文案的一部分）
      { write: "s" }, // scoped：只放行 bash:<首词> 这一类
      { wait: "请回答", answer: "y", withinMs: 2500 }, // 仅"s 未生效→重复询问"的实现出现；生效实现超时跳过
      { wait: "write 请求执行" }, // write 的询问（两种实现下都会出现）
      { write: "y" }, // write 的逐次放行
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
      max_count: { "允许?": 2 }, // 询问恰好两次（bash + write）：重复询问 = s 未生效
    },
    artifacts: {
      "notes/bash-target.txt": "bash-ran-4e9\n", // bash 经 scoped/逐次放行后执行
      "notes/write-target.txt": "written-by-model\n", // write 经逐次放行后执行
    },
  },
};
