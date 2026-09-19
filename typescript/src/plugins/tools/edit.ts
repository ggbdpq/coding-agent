// edit 工具：精确字符串替换——coding agent 改代码的主力。
// old_string 必须在文件中唯一（否则要求补上下文或显式 replace_all），防止误伤。
// 路径先过守卫：越出工作目录的编辑在权限确认时醒目提示。
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { definePlugin } from '../../kernel/plugin.ts';
import { previewDiff } from '../../kernel/ui.ts';
import { resolvePath } from './pathguard.ts';

export interface EditResult {
  ok: boolean;
  /** ok 时为替换档位（one/all），否则为错误信息 */
  message: string;
}

/** 纯函数，方便单测：在 content 上执行一次精确替换 */
export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): EditResult {
  if (!oldString) return { ok: false, message: '错误：old_string 不能为空' };
  const count = content.split(oldString).length - 1;
  if (count === 0) {
    return {
      ok: false,
      message: '错误：未找到 old_string，请先 read 文件核对精确内容（含缩进与换行）',
    };
  }
  if (count > 1 && !replaceAll) {
    return {
      ok: false,
      message: `错误：old_string 出现了 ${count} 次。请加入更多上下文使其唯一；确认要全部替换时设 replace_all=true`,
    };
  }
  return { ok: true, message: replaceAll ? 'all' : 'one' };
}

export default definePlugin({
  name: 'edit',
  kind: 'tool',
  description:
    '对文件做精确字符串替换：old_string 必须与文件内容完全一致（含缩进）。多处出现且需全部替换时设 replace_all=true。',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '目标文件路径' },
      old_string: { type: 'string', description: '要被替换的精确原文' },
      new_string: { type: 'string', description: '替换后的新文本' },
      replace_all: { type: 'boolean', description: '全部替换，默认 false' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  needsPermission: true,
  skipPermission: (a, app) => {
    // 白名单免确认（与 write 同规则）：目标在 config.allowWriteDirs 内
    const dirs = app.config.allowWriteDirs ?? [];
    if (dirs.length === 0) return false;
    const target = path.resolve(String(a.file_path ?? ''));
    return dirs.some((d) => {
      const root = path.resolve(d);
      return target === root || target.startsWith(root + path.sep);
    });
  },
  preview: (a) => {
    const { outside } = resolvePath(String(a.file_path ?? ''));
    const flag = outside ? '\n⚠ 注意：该路径在当前工作目录之外！' : '';
    return `编辑 ${String(a.file_path)}${flag}\n${previewDiff(
      String(a.old_string ?? ''),
      String(a.new_string ?? '')
    )}`;
  },
  async run(args) {
    const file = String(args.file_path ?? '');
    const oldString = String(args.old_string ?? '');
    const newString = String(args.new_string ?? '');
    const replaceAll = args.replace_all === true;
    if (!file) return '错误：缺少 file_path';
    const { abs } = resolvePath(file);
    let content: string;
    try {
      content = await readFile(abs, 'utf8');
    } catch {
      return `错误：无法读取 ${file}（不存在或不可读）`;
    }
    const check = applyEdit(content, oldString, newString, replaceAll);
    if (!check.ok) return check.message;
    const next = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);
    await writeFile(abs, next, 'utf8');
    const count = replaceAll ? content.split(oldString).length - 1 : 1;
    return `已替换 ${file} 中 ${count} 处内容`;
  },
});
