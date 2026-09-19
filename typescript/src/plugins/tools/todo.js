// todo 工具：会话内任务清单——插件 API 的活样例（见 docs/plugin-template.md）。
// 状态存在本插件闭包里：进程内存活，/new 不清空、退出即失；
// 刻意做小，只演示"加一个工具 = 加一个文件 + 清单一行"。
import { definePlugin } from '../../kernel/plugin.ts';
const items = [];
let nextId = 1;
export default definePlugin({
    name: 'todo',
    kind: 'tool',
    description: '维护会话内任务清单（add/list/done/clear），多步任务时用来跟踪进度。',
    parameters: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['add', 'list', 'done', 'clear'], description: '操作' },
            text: { type: 'string', description: 'add 时的任务内容' },
            id: { type: 'number', description: 'done 时的任务编号' },
        },
        required: ['action'],
    },
    needsPermission: false,
    preview: (a) => `todo ${String(a.action ?? '')}`,
    async run(args) {
        const action = String(args.action ?? 'list');
        if (action === 'add') {
            const text = String(args.text ?? '').trim();
            if (!text)
                return '错误：add 需要 text';
            const id = nextId++;
            items.push({ id, text, done: false });
            return `已添加 #${id}：${text}`;
        }
        if (action === 'done') {
            const item = items.find((i) => i.id === Number(args.id));
            if (!item)
                return `错误：没有 #${args.id} 这条任务`;
            item.done = true;
            return `已完成 #${item.id}：${item.text}`;
        }
        if (action === 'clear') {
            const n = items.length;
            items.length = 0;
            return `已清空 ${n} 条任务`;
        }
        if (items.length === 0)
            return '（清单为空）';
        return items.map((i) => `${i.done ? '[x]' : '[ ]'} #${i.id} ${i.text}`).join('\n');
    },
});
