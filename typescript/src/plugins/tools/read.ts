// read 工具：带行号读文件，支持 offset/limit 分段；超大文件拒读并提示分段。
// 路径先过守卫统一解析（读操作免确认，但解析规则与写类保持一致）。
import { readFile, stat } from 'node:fs/promises';
import { definePlugin } from '../../kernel/plugin.ts';
import { resolvePath } from './pathguard.ts';

const MAX_BYTES = 1024 * 1024;
const DEFAULT_LIMIT = 2000;

export default definePlugin({
  name: 'read',
  kind: 'tool',
  description:
    '读取文件内容，带行号（1-based）。大文件可用 offset（起始行）和 limit（最多行数）分段读取。',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '文件路径，相对当前目录或绝对路径' },
      offset: { type: 'number', description: '起始行号（1-based），默认 1' },
      limit: { type: 'number', description: `最多读取行数，默认 ${DEFAULT_LIMIT}` },
    },
    required: ['file_path'],
  },
  needsPermission: false,
  preview: (a) => `read ${String(a.file_path)}`,
  async run(args) {
    const file = String(args.file_path ?? '');
    if (!file) return '错误：缺少 file_path';
    const { abs } = resolvePath(file);
    const st = await stat(abs).catch(() => null);
    if (!st) return `错误：文件不存在：${file}`;
    if (st.isDirectory()) return `错误：${file} 是目录，请用 glob 列文件`;
    if (st.size > MAX_BYTES) {
      return `错误：文件过大（${st.size} 字节，上限 ${MAX_BYTES}），请用 offset/limit 分段读取`;
    }
    const text = await readFile(abs, 'utf8');
    const lines = text.split('\n');
    const total = lines.length;
    const start = Math.max(0, Math.min(Number(args.offset ?? 1) - 1, total - 1));
    const limit = Math.max(1, Number(args.limit ?? DEFAULT_LIMIT));
    const slice = lines.slice(start, start + limit);
    const body = slice.map((l, i) => `${String(start + i + 1).padStart(6)}\t${l}`).join('\n');
    const note =
      start + limit < total
        ? `\n（已显示第 ${start + 1}-${Math.min(start + limit, total)} 行，共 ${total} 行；继续读请调大 offset）`
        : '';
    return body + note;
  },
});
