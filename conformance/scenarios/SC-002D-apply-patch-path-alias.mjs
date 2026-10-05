// SC-002D：词法路径别名不应绕过 R8 的单目标约束；其余输入和字节断言复用 SC-002C。
import duplicateTarget from "./SC-002C-apply-patch-duplicate-target.mjs";

const edits = structuredClone(duplicateTarget.input.model_script.tool.arguments.edits);
edits[2].file_path = "./fixture/project/src/../src/example.ts";

export default {
  ...duplicateTarget,
  id: "SC-002D",
  title: "apply_patch 路径别名——规范后重复目标整体拒绝",
  purpose: "相对路径中的 . 与 .. 不能绕过单文件只允许一条 edit 的预验规则",
  input: {
    ...duplicateTarget.input,
    model_script: {
      ...duplicateTarget.input.model_script,
      tool: {
        ...duplicateTarget.input.model_script.tool,
        arguments: { edits },
      },
    },
  },
};
