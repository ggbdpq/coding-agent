// /new：开新会话——messages 换新 system 数组并换新会话文件。
import { definePlugin } from '../../kernel/plugin.ts';
import { c } from '../../kernel/ui.ts';
export default definePlugin({
    name: 'new',
    kind: 'command',
    usage: '/new',
    summary: '开新会话（清空上下文）',
    async run(app) {
        app.resetMessages();
        app.startSession();
        console.log(c.green('已开新会话，上下文已清空。'));
    },
});
