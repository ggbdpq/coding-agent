// 一轮用户输入的完整编排：裁剪 → 入列 → 工具循环 → 断尾修复 → 会话落盘。
// 所有壳共用这里，保证裁剪/落盘/修复语义全项目只有一份。
// v1 事件模型：turn 是唯一生产者，通过 emit 发出规范 AgentEvent（kernel/types），
// 壳只订阅不拼装——加功能=加事件类型，不动消费端接口。
import { randomUUID } from 'node:crypto';
import { runTurn } from './agentloop.ts';
import { compactContext } from './compact.ts';
import { trimContext, estimateTokens } from './trim.ts';
export async function runUserTurn(app, line, hooks) {
    const emit = (ev) => hooks.emit(ev);
    // 轮前上下文治理（双档）：估算超预算 80% 先试摘要压缩（保留任务目标与最近原文），
    // 仍超限再退裁剪（丢最旧工具输出兜底）
    if (estimateTokens(app.messages) > app.config.contextLimit * 0.8) {
        try {
            const { savedTokens } = await compactContext(app, { signal: hooks.signal });
            emit({ type: 'compact', savedTokens });
        }
        catch {
            const cut = trimContext(app.messages, app.config.contextLimit);
            if (cut.trimmed > 0)
                emit({ type: 'trimmed', count: cut.trimmed });
        }
    }
    emit({ type: 'turn_start', id: randomUUID() });
    emit({ type: 'user', text: line });
    app.messages.push({ role: 'user', content: line });
    const mark = app.messages.length - 1;
    const appendSince = () => {
        for (const m of app.messages.slice(mark))
            app.store.append(m);
    };
    let reason = 'completed';
    let errorMessage;
    try {
        await runTurn(app.messages, {
            provider: app.provider,
            tools: app.registry.tools(),
            app,
            check: hooks.check,
            signal: hooks.signal,
            onText: (delta) => emit({ type: 'text_delta', delta }),
            onToolCall: (callId, name, args) => emit({ type: 'tool_call', call_id: callId, name, args }),
            onToolResult: (callId, name, result, ms) => emit({ type: 'tool_result', call_id: callId, name, summary: result.split('\n')[0], ms }),
            onUsage: (usage) => emit({ type: 'usage', ...usage }),
        });
    }
    catch (e) {
        const err = e;
        if (err.name === 'AbortError')
            reason = 'aborted';
        else {
            reason = 'error';
            errorMessage = err.message;
        }
        // 中断可能留下"有工具调用、无回应"的断尾，补占位保证消息序列对 API 合法
        const last = app.messages[app.messages.length - 1];
        if (last?.role === 'assistant' && last.tool_calls) {
            const answered = new Set(app.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
            for (const tc of last.tool_calls) {
                if (!answered.has(tc.id)) {
                    app.messages.push({ role: 'tool', tool_call_id: tc.id, content: '（用户中止，未执行）' });
                }
            }
        }
        appendSince();
        emit({ type: 'turn_end', reason, error: errorMessage });
        throw e; // 展示方式是壳的事：REPL 区分中止/出错，web 转 SSE 事件
    }
    appendSince();
    emit({ type: 'turn_end', reason: 'completed' });
}
