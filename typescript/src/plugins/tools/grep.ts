// grep 工具：按正则搜文件内容（ripgrep，尊重 .gitignore）。一工具一文件。
import { definePlugin } from '../../kernel/plugin.ts';
import { runRg } from './rg.ts';

export default definePlugin({
  name: 'grep',
  kind: 'tool',
  description: '按正则搜文件内容（ripgrep 语法，智能大小写），返回 行号:内容',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式' },
      path: { type: 'string', description: '限定搜索的目录或文件，默认当前目录' },
      include: { type: 'string', description: '文件名 glob 过滤，如 "*.ts"' },
    },
    required: ['pattern'],
  },
  needsPermission: false,
  preview: (a) => `grep ${String(a.pattern ?? '')}`,
  async run(args) {
    const pattern = String(args.pattern ?? '');
    if (!pattern) return '错误：缺少 pattern';
    const rgArgs = ['-n', '-S'];
    if (args.include) rgArgs.push('-g', String(args.include));
    rgArgs.push('--', pattern, String(args.path ?? '.'));
    return await runRg(rgArgs);
  },
});
