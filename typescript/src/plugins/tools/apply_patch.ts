// apply_patch 工具：多文件原子编辑——先对全部编辑做预验（每条 old_string 必须在其
// 文件中唯一存在），任一失败则整体不应用并逐条报告；全部通过后才写入。
// 原子性说明：预验与写入之间无并发写者（tcode 工具循环串行），因此"全预验→全写入"
// 即实际原子；安全边界：逐次确认，preview 列出全部目标文件。
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { definePlugin } from '../../kernel/plugin.ts';
import { resolvePath } from './pathguard.ts';

export interface PatchEdit {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

interface PreparedEdit {
  abs: string;
  display: string;
  original: string;
  next: string;
}

export const applyPatchToolName = 'apply_patch';

export default definePlugin({
  name: 'apply_patch',
  kind: 'tool',
  description:
    '对多个文件一次应用多处精确替换（原子操作：全部预验通过才写入，任一失败整体放弃）。' +
    '适合跨文件的重命名/批量调整；单文件小改动仍优先用 edit。',
  parameters: {
    type: 'object',
    properties: {
      edits: {
        type: 'array',
        description: '编辑列表，每项 {file_path, old_string, new_string, replace_all?}',
        items: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            old_string: { type: 'string' },
            new_string: { type: 'string' },
            replace_all: { type: 'boolean' },
          },
          required: ['file_path', 'old_string', 'new_string'],
        },
      },
    },
    required: ['edits'],
  },
  needsPermission: true,
  preview: (a) => {
    const edits = Array.isArray(a.edits) ? (a.edits as PatchEdit[]) : [];
    const files = [...new Set(edits.map((e) => String(e.file_path)))];
    return `原子补丁：${edits.length} 处编辑，涉及 ${files.length} 个文件\n${files
      .map((f) => `  · ${f}`)
      .join('\n')}`;
  },
  async run(args) {
    const raw = Array.isArray(args.edits) ? (args.edits as unknown[]) : [];
    if (raw.length === 0) return '错误：edits 不能为空';

    // 第一阶段：全量预验（读文件 + 唯一性检查），不改任何磁盘内容
    const cache = new Map<string, string>();
    const prepared: PreparedEdit[] = [];
    const errors: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      const e = raw[i] as Partial<PatchEdit>;
      const file = String(e.file_path ?? '');
      const oldString = String(e.old_string ?? '');
      const newString = String(e.new_string ?? '');
      if (!file || !oldString) {
        errors.push(`#${i}：缺少 file_path 或 old_string`);
        continue;
      }
      let original = cache.get(file);
      if (original === undefined) {
        try {
          original = await readFile(resolvePath(file).abs, 'utf8');
        } catch {
          errors.push(`#${i}：无法读取 ${file}`);
          continue;
        }
        cache.set(file, original);
      }
      const count = original.split(oldString).length - 1;
      if (count === 0) {
        errors.push(`#${i}：${file} 中未找到 old_string`);
      } else if (count > 1 && !e.replace_all) {
        errors.push(`#${i}：${file} 中 old_string 出现 ${count} 次（需 replace_all 或更多上下文）`);
        continue;
      }
      const next =
        e.replace_all && count > 1
          ? original.split(oldString).join(newString)
          : original.replace(oldString, newString);
      prepared.push({ abs: resolvePath(file).abs, display: file, original, next });
    }
    if (errors.length > 0) {
      return `错误：预验未通过，未写入任何文件。\n${errors.map((s) => `- ${s}`).join('\n')}`;
    }

    // 第二阶段：全部通过，逐文件写入
    for (const p of prepared) {
      await writeFile(p.abs, p.next, 'utf8');
    }
    return `已应用补丁：${prepared.length} 处编辑，涉及 ${new Set(prepared.map((p) => p.display)).size} 个文件`;
  },
});
