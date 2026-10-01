// SC-002B：apply_patch 原子性臂——任一编辑预验失败则整体零写入（无半修改状态）。
// 期望值来源：apply_patch 工具契约（全预验→全写入，任一失败整体放弃并折叠为「错误：…」回流）。
export default {
  id: "SC-002B",
  title: "apply_patch 原子性——任一编辑失败整体零写入",
  purpose: "验证失败边界：第一个文件合法、第二个文件预验失败时，不得出现半修改状态",
  related_specs: ["tool-protocol.md#R3（错误折叠为「错误：…」回流）", "agent-loop.md#R3（五出口）"],
  maturity: "frozen", // 五版首跑 PASS + 红操演练转红（2026-10-01）
  coverage: "all",
  input: {
    entry: "exec",
    approval: "yolo", // 原子性与审批解耦：yolo 下唯一防线是补丁预验
    protocol: "openai",
    task: "按补丁更新两个文件",
    fixtures: {
      "fixture/project/src/example.ts": 'export function hello() {\n  return "old";\n}\n',
      "fixture/project/src/other.ts": "export const other = true;\n",
    },
    model_script: {
      kind: "tool-then-text",
      tool: {
        name: "apply_patch",
        arguments: {
          edits: [
            { file_path: "fixture/project/src/example.ts", old_string: 'return "old";', new_string: 'return "new";' },
            { file_path: "fixture/project/src/other.ts", old_string: "不存在的原文", new_string: "x" },
          ],
        },
      },
      final_text: "补丁未能应用。",
    },
  },
  expect: {
    verdict: { level: "ok", exit: 0 },
    provider_requests: {
      count: 2,
      items: [{ nth: 2, last_tool_message_startswith: "错误：" }],
    },
    artifacts: {
      "fixture/project/src/example.ts": "unchanged", // 原子性核心：合法的第一编辑也不得落盘
      "fixture/project/src/other.ts": "unchanged",
    },
  },
};
