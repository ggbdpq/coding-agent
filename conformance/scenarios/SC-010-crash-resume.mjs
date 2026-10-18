// SC-010：崩溃恢复——工具执行中进程被强杀后，携恢复旗标重启，重启后的第一个请求必须
// 携带完整且配对的历史。期望值来源：session-turn.md 修订草案（落盘时机=每产生一条消息就
// append：崩溃前已产生的 user / assistant(tool_calls) 消息不丢；加载会话时对历史文件里
// 悬空的 tool_calls 补占位 tool 消息）+ event.md R8（占位文案「（用户中止，未执行）」为
// 五版逐字锁定契约）+ agent-loop 本质约束 1（消息配对不变量：任何出口不悬空）。
// 第一阶段 exec 模式：剧本给一个长命令工具调用，stdout 出现 [tool] 标记（工具开始执行的
// 五版统一标记，S3 通道契约）即 SIGKILL——模拟工具执行中崩溃；第二阶段 repl + 恢复旗标
// （--continue，五版统一入口契约）继续对话。
// 现行"轮末一次性落盘"的实现崩溃即丢整轮：重启后的第一个请求只有 system+新 user，
// 不含占位 tool 消息——本场景据此抓漂移。
export default {
  id: "SC-010",
  title: "崩溃恢复——工具执行中崩溃后重启，首个请求历史完整且无悬空 tool_calls",
  purpose: "验证逐消息落盘与加载断尾修复：崩溃前消息都在，重启后第一次请求序列合法、悬空已补占位",
  related_specs: [
    "session-turn.md#修订草案（每产生一条消息就 append；加载时修复断尾）",
    "event.md#R8（断尾占位文案逐字锁定）",
    "agent-loop.md#本质约束1（消息配对不变量）",
  ],
  maturity: "draft", // ADR-003 TS 先行：非参考实现差异按 normalization-policy E9 判 ALLOW_DIFF（复查 2026-11-18）
  coverage: "all",
  input: {
    entry: "crash-resume", // 第一阶段 exec 跑到 crash_marker 即 SIGKILL；第二阶段 repl + 恢复旗标 + stdin
    approval: "yolo",
    protocol: "openai",
    task: "跑一个耗时命令",
    crash_marker: "[tool]", // 工具开始执行的统一标记（S3 通道契约）
    stdin: [
      { write: "继续之前的任务" },
      { wait: "RESUME-DONE-6d4" },
      { write: "/exit" },
    ],
    model_script: {
      kind: "steps",
      steps: [
        { tool_call: { name: "bash", arguments: { command: "sleep 30" } } }, // 第 1 次请求（崩溃前）
        { text: "恢复完成：RESUME-DONE-6d4" }, // 第 2 次请求（重启后首个）
      ],
    },
  },
  expect: {
    verdict: { level: "ok", exit: 0 },
    provider_requests: {
      count: 2,
      items: [
        {
          nth: 2, // 重启后的第一次请求
          no_dangling_tool_calls: true, // 消息配对合法：assistant(tool_calls) 不悬空
          has_tool_message_equals: "（用户中止，未执行）", // 断尾已补占位（event R8 锁定文案）
        },
      ],
    },
  },
};
