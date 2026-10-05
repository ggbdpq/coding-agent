// memory_append：长期记忆的受控沉淀路径——只追加到 <数据目录>/memory.md，
// 不覆盖/删除既有内容；写入走逐次审批。memory.md 由系统提示词注入每轮对话。
import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { definePlugin } from '../../kernel/plugin.ts';
import { resolveTcodeDir } from '../../kernel/config.ts';

export default definePlugin({
  name: 'memory_append',
  kind: 'tool',
  description: '把值得跨会话记住的信息（用户偏好、项目约定、重要结论）追加到长期记忆。只追加，不能修改或删除既有条目。',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: '要记住的一 条信息（不超过 500 字符）' },
    },
    required: ['content'],
  },
  needsPermission: true,
  preview: (args) => `追加到长期记忆：${String(args?.content ?? '').slice(0, 300)}`,
  async run(args) {
    const text = String(args?.content ?? '').trim();
    if (!text) return '错误：content 不能为空';
    if (text.length > 500) return '错误：单条记忆不超过 500 字符';
    const file = path.join(resolveTcodeDir(), 'memory.md');
    if (!existsSync(file)) {
      appendFileSync(file, '# 长期记忆\n', { mode: 0o600 });
    }
    appendFileSync(file, `- ${text}\n`, { mode: 0o600 });
    return `已记录到长期记忆（下轮对话注入）：${text}`;
  },
});
