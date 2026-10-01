// SC-002A：apply_patch 成功臂——审批边界（y 确认）通过后，多文件补丁全部落盘。
// 期望值来源：tool-protocol.md#R2（apply_patch 逐次确认、无白名单豁免）+ 工具语义（edits 全应用）。
export default {
  id: "SC-002A",
  title: "apply_patch 成功臂——审批边界确认后多文件补丁全部落盘",
  purpose: "验证 mutation 契约：审批通过前不落盘，确认后全部编辑按字节精确应用",
  related_specs: ["tool-protocol.md#R2（apply_patch 逐次确认）", "tool-protocol.md#R3"],
  maturity: "frozen", // 五版首跑 PASS + 红操演练转红（2026-10-01）
  coverage: "all",
  input: {
    entry: "repl-script",
    approval: "interactive", // 关键：验证审批边界——确认前不得写入
    protocol: "openai",
    task: "按补丁更新两个文件",
    stdin: [
      { write: "按补丁更新两个文件" },
      { wait: "允许" },
      { write: "y" },
      { wait: "PATCH-OK-3f9" },
      { write: "/exit" },
    ],
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
            { file_path: "fixture/project/src/other.ts", old_string: "export const other = true;", new_string: "export const other = true; // patched" },
          ],
        },
      },
      final_text: "补丁已应用：PATCH-OK-3f9",
    },
  },
  expect: {
    verdict: { level: "ok", exit: 0 },
    provider_requests: { count: 2 },
    artifacts: {
      "fixture/project/src/example.ts": 'export function hello() {\n  return "new";\n}\n',
      "fixture/project/src/other.ts": "export const other = true; // patched\n",
    },
  },
};
