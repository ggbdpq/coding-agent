// SC-002C：同一目标的多条编辑必须在预验阶段整体拒绝，包含先前合法的其他目标。
// 期望值只取自 tool-protocol.md#R8，不从参考实现的后写覆盖行为推导。
export default {
  id: "SC-002C",
  title: "apply_patch 重复目标——整批拒绝且零写入",
  purpose: "同一文件两条有效编辑不能以后写覆盖方式提交；其他合法文件也保持原字节",
  related_specs: ["tool-protocol.md#R8（规范路径唯一、预验失败零写入）", "tool-protocol.md#R3"],
  maturity: "frozen",
  coverage: "all",
  input: {
    entry: "exec",
    approval: "yolo",
    protocol: "openai",
    task: "应用给定的文件补丁",
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
            { file_path: "fixture/project/src/other.ts", old_string: "other", new_string: "another" },
            { file_path: "fixture/project/src/example.ts", old_string: 'return "old";', new_string: 'return "new";' },
            { file_path: "fixture/project/src/example.ts", old_string: "hello", new_string: "greet" },
          ],
        },
      },
      final_text: "重复目标已拒绝。",
    },
  },
  expect: {
    verdict: { level: "ok", exit: 0 },
    provider_requests: {
      count: 2,
      items: [{ nth: 2, last_tool_message_startswith: "错误：预验未通过，未写入任何文件。" }],
    },
    artifacts: {
      "fixture/project/src/example.ts": "unchanged",
      "fixture/project/src/other.ts": "unchanged",
    },
  },
};
