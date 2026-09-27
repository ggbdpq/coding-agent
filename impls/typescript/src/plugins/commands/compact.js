// /compact：手动触发上下文摘要压缩（自动触发见 core/turn.ts 的超限治理）。
import { compactContext } from '../../core/compact.ts';
import { definePlugin } from '../../kernel/plugin.ts';
export default definePlugin({
    name: 'compact',
    kind: 'command',
    usage: '/compact',
    summary: '把当前对话压缩成摘要，释放上下文预算',
    async run(app) {
        try {
            const { savedTokens } = await compactContext(app, {});
            console.log(`已压缩：替换为任务摘要，节省约 ${savedTokens} tokens 的上下文预算。`);
        }
        catch (e) {
            console.log(`压缩未执行：${e.message}`);
        }
    },
});
