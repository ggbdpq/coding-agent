// glob 工具：按 glob 模式列文件（ripgrep，尊重 .gitignore）。一工具一文件。
import { definePlugin } from '../../kernel/plugin.ts';
import { runRg } from './rg.ts';
export default definePlugin({
    name: 'glob',
    kind: 'tool',
    description: '按 glob 模式列文件（尊重 .gitignore），如 "*.ts"、"src/**/*.test.ts"',
    parameters: {
        type: 'object',
        properties: {
            pattern: { type: 'string', description: 'glob 模式' },
        },
        required: ['pattern'],
    },
    needsPermission: false,
    preview: (a) => `glob ${String(a.pattern ?? '')}`,
    async run(args) {
        const pattern = String(args.pattern ?? '');
        if (!pattern)
            return '错误：缺少 pattern';
        return await runRg(['--files', '-g', pattern]);
    },
});
