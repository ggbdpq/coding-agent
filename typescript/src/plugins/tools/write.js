// write 工具：整文件写入（新文件/整体重写），自动建父目录。
// 模型给的路径先过路径守卫：越出工作目录的目标在权限确认时醒目提示，由人工把关。
// 白名单免确认（蓝图 R4）：config.allowWriteDirs 内的目标跳过逐次确认。
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { definePlugin } from '../../kernel/plugin.ts';
import { ellipsis } from '../../kernel/ui.ts';
import { resolvePath } from './pathguard.ts';
/** 白名单判定：目标 === 根目录，或位于某白名单根目录之下（规范惯用法） */
function insideAllowDirs(file, app) {
    const dirs = app.config.allowWriteDirs ?? [];
    if (dirs.length === 0)
        return false;
    const target = path.resolve(file);
    return dirs.some((d) => {
        const root = path.resolve(d);
        return target === root || target.startsWith(root + path.sep);
    });
}
export default definePlugin({
    name: 'write',
    kind: 'tool',
    description: '将内容写入文件（整体覆盖，自动创建父目录）。修改已有文件请优先用 edit 做精确替换。',
    parameters: {
        type: 'object',
        properties: {
            file_path: { type: 'string', description: '目标文件路径' },
            content: { type: 'string', description: '完整文件内容' },
        },
        required: ['file_path', 'content'],
    },
    needsPermission: true,
    skipPermission: (a, app) => insideAllowDirs(String(a.file_path ?? ''), app),
    preview: (a) => {
        const { outside } = resolvePath(String(a.file_path ?? ''));
        const flag = outside ? '\n⚠ 注意：该路径在当前工作目录之外！' : '';
        return `写入 ${String(a.file_path)}${flag}\n${ellipsis(String(a.content ?? ''), 4000)}`;
    },
    async run(args) {
        const file = String(args.file_path ?? '');
        if (!file)
            return '错误：缺少 file_path';
        if (args.content === undefined)
            return '错误：缺少 content';
        const { abs } = resolvePath(file);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, String(args.content), 'utf8');
        const lines = String(args.content).split('\n').length;
        return `已写入 ${file}（${String(args.content).length} 字符 / ${lines} 行）`;
    },
});
