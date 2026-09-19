import { toSchemas } from '../kernel/registry.ts';
/** 防失控：单轮对话最多允许的工具往返次数 */
export const MAX_TOOL_ROUNDS = 40;
export async function runTurn(messages, deps) {
    const schemas = toSchemas(deps.tools);
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const opts = {
            tools: schemas,
            signal: deps.signal,
            onText: deps.onText,
            onUsage: deps.onUsage,
        };
        const { message } = await deps.provider.chat(messages, opts);
        messages.push(message);
        if (!message.tool_calls?.length)
            return;
        for (const call of message.tool_calls) {
            let args = {};
            try {
                const parsed = JSON.parse(call.function.arguments || '{}');
                if (parsed && typeof parsed === 'object')
                    args = parsed;
            }
            catch {
                // 参数不是合法 JSON：不在这里报错，落下去让工具名的"错误"文本纠正模型
            }
            const tool = deps.tools.find((t) => t.name === call.function.name);
            if (!tool) {
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: `错误：未知工具 ${call.function.name}。可用工具：${deps.tools.map((t) => t.name).join(', ')}`,
                });
                continue;
            }
            deps.onToolCall?.(call.id, tool.name, args);
            // 白名单优先（skipPermission 声明受信）→ 闸门逐次确认
            const allowed = tool.needsPermission && deps.check && !tool.skipPermission?.(args, deps.app)
                ? await deps.check(tool.name, tool.preview(args))
                : true;
            if (!allowed) {
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: '用户拒绝了本次操作。请询问用户怎么办，或换一种方式；不要未经允许重试同样的操作。',
                });
                deps.onToolResult?.(call.id, tool.name, '（用户已拒绝）', 0);
                continue;
            }
            const t0 = Date.now();
            let result;
            try {
                result = await tool.run(args, deps.signal);
            }
            catch (e) {
                result = `错误：${e.message}`;
            }
            const ms = Date.now() - t0;
            messages.push({ role: 'tool', tool_call_id: call.id, content: result });
            deps.onToolResult?.(call.id, tool.name, result, ms);
        }
    }
    // 轮次熔断：不带工具再要一次总结，防止无限打转
    const { message } = await deps.provider.chat(messages, {
        signal: deps.signal,
        onText: deps.onText,
        onUsage: deps.onUsage,
    });
    messages.push(message);
}
