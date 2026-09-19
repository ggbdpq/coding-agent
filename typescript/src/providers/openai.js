// OpenAI 兼容 /chat/completions 客户端 + 对应 provider 插件（兜底：matches 恒真）。
// 只支持流式——coding agent 的体感底线，也顺便让工具调用前的等待可见。
import { sseData } from './sse.ts';
import { RetryableError, withRetry } from './retry.ts';
import { definePlugin } from '../kernel/plugin.ts';
export class Provider {
    // 注意：Node 类型剥离不支持构造函数参数属性，字段必须显式声明
    baseUrl;
    apiKey;
    model;
    constructor(baseUrl, apiKey, model) {
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
        this.model = model;
    }
    /** 最多 3 次尝试；仅首字节前可重试（流已开始的中断不重试，避免内容重复） */
    chat(messages, opts = {}) {
        return withRetry(() => this.attempt(messages, opts));
    }
    async attempt(messages, opts) {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: this.model,
                messages,
                tools: opts.tools && opts.tools.length > 0 ? opts.tools : undefined,
                stream: true,
                stream_options: { include_usage: true },
            }),
            signal: opts.signal,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            const brief = text.length > 300 ? `${text.slice(0, 300)}…` : text;
            const retryable = res.status === 429 || res.status >= 500;
            throw retryable
                ? new RetryableError(`HTTP ${res.status}：${brief || res.statusText}`)
                : new Error(`HTTP ${res.status}：${brief || res.statusText}`);
        }
        if (!res.body)
            throw new Error('响应没有正文流');
        // 流式增量装配：正文直接累加；工具调用按 index 分槽拼装碎片
        let content = '';
        const calls = new Map();
        for await (const data of sseData(res.body)) {
            if (data === '[DONE]')
                break;
            let chunk;
            try {
                chunk = JSON.parse(data);
            }
            catch {
                continue; // 非 JSON 行（注释、心跳）直接跳过
            }
            if (chunk.usage?.prompt_tokens || chunk.usage?.completion_tokens) {
                opts.onUsage?.({
                    prompt_tokens: chunk.usage.prompt_tokens ?? 0,
                    completion_tokens: chunk.usage.completion_tokens ?? 0,
                });
            }
            const choice = chunk.choices?.[0];
            if (!choice)
                continue;
            const delta = choice.delta ?? {};
            if (delta.content) {
                content += delta.content;
                opts.onText?.(delta.content);
            }
            for (const tc of delta.tool_calls ?? []) {
                const slot = calls.get(tc.index) ?? { id: '', name: '', args: '' };
                if (tc.id)
                    slot.id = tc.id;
                if (tc.function?.name)
                    slot.name += tc.function.name;
                if (tc.function?.arguments)
                    slot.args += tc.function.arguments;
                calls.set(tc.index, slot);
            }
        }
        const tool_calls = [...calls.entries()]
            .sort(([a], [b]) => a - b)
            .map(([i, s]) => ({
            id: s.id || `call_${i}`,
            type: 'function',
            function: { name: s.name, arguments: s.args || '{}' },
        }));
        return {
            message: {
                role: 'assistant',
                content: content || null,
                ...(tool_calls.length > 0 ? { tool_calls } : {}),
            },
        };
    }
}
export default definePlugin({
    name: 'openai',
    kind: 'provider',
    // 兜底：注册顺序放清单最后，没被其他 provider 命中的 BASE_URL 都走 OpenAI 兼容
    matches: () => true,
    create: (config) => new Provider(config.baseUrl, config.apiKey, config.model),
});
