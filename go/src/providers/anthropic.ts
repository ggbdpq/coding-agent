// Anthropic Messages 协议客户端（POST {baseUrl}/v1/messages）+ provider 插件：
// 服务于 Claude 官方 API、DeepSeek /anthropic 端点及同类兼容中转。
// 消息映射：system 提为顶层参数；tool 消息转为 user 角色的 tool_result 块；
// 相邻同角色消息合并（Anthropic 要求 user/assistant 严格交替）。
import { sseData } from './sse.ts';
import { RetryableError, withRetry } from './retry.ts';
import { definePlugin } from '../kernel/plugin.ts';
import type {
  ChatClient,
  ChatMessage,
  ChatOptions,
  CompletionResult,
  ToolCall,
  ToolSchema,
} from '../kernel/types.ts';
import type { Config } from '../kernel/config.ts';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 8192;

type Block = {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
};

/** 内部（OpenAI 形状）消息 → Anthropic 请求体 */
export function toAnthropicRequest(
  messages: ChatMessage[],
  model: string,
  maxTokens: number,
  tools?: ToolSchema[]
): Record<string, unknown> {
  const system: string[] = [];
  const flat: Array<{ role: 'user' | 'assistant'; content: Block[] }> = [];
  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) system.push(m.content);
      continue;
    }
    if (m.role === 'user') {
      flat.push({ role: 'user', content: [{ type: 'text', text: m.content ?? '' }] });
      continue;
    }
    if (m.role === 'tool') {
      flat.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: m.content ?? '' }],
      });
      continue;
    }
    const blocks: Block[] = [];
    if (m.content) blocks.push({ type: 'text', text: m.content });
    for (const tc of m.tool_calls ?? []) {
      let input: unknown = {};
      try {
        input = JSON.parse(tc.function.arguments || '{}');
      } catch {
        /* 非法参数保持 {}，让对端/工具层报错 */
      }
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
    flat.push({ role: 'assistant', content: blocks });
  }
  const merged: typeof flat = [];
  for (const m of flat) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content.push(...m.content);
    else merged.push(m);
  }
  return {
    model,
    max_tokens: maxTokens,
    system: system.length > 0 ? system.join('\n') : undefined,
    messages: merged,
    tools:
      tools && tools.length > 0
        ? tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            input_schema: t.function.parameters,
          }))
        : undefined,
    stream: true,
  };
}

type AnthropicEvent = {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  error?: { message?: string };
};

export class AnthropicProvider implements ChatClient {
  // Node 类型剥离不支持构造函数参数属性，字段必须显式声明
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(baseUrl: string, apiKey: string, model: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.model = model;
  }

  /** 与 OpenAI 版相同的重试纪律：最多 3 次，仅首字节前可重试 */
  chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<CompletionResult> {
    return withRetry(() => this.attempt(messages, opts));
  }

  private async attempt(messages: ChatMessage[], opts: ChatOptions): Promise<CompletionResult> {
    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        authorization: `Bearer ${this.apiKey}`,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(toAnthropicRequest(messages, this.model, DEFAULT_MAX_TOKENS, opts.tools)),
      signal: opts.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const brief = text.length > 300 ? `${text.slice(0, 300)}…` : text;
      const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
      throw retryable
        ? new RetryableError(`HTTP ${res.status}：${brief || res.statusText}`)
        : new Error(`HTTP ${res.status}：${brief || res.statusText}`);
    }
    if (!res.body) throw new Error('响应没有正文流');

    // 事件装配：text_delta 累加正文；tool_use 块按 index 收 input_json_delta 碎片
    let text = '';
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();

    for await (const data of sseData(res.body)) {
      let ev: AnthropicEvent;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      if (ev.type === 'error') {
        throw new Error(`流内错误：${ev.error?.message ?? data}`);
      }
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        toolBlocks.set(ev.index ?? 0, {
          id: ev.content_block.id ?? '',
          name: ev.content_block.name ?? '',
          json: '',
        });
        continue;
      }
      if (ev.type === 'content_block_delta') {
        const d = ev.delta ?? {};
        if (d.type === 'text_delta' && d.text) {
          text += d.text;
          opts.onText?.(d.text);
        } else if (d.type === 'input_json_delta' && d.partial_json) {
          const b = toolBlocks.get(ev.index ?? 0);
          if (b) b.json += d.partial_json;
        }
      }
      // message_delta / message_stop / ping：块拼完即返回，无需特殊处理
    }

    const tool_calls: ToolCall[] = [...toolBlocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([i, b]) => {
        // 解析一遍再序列化：既验证 JSON 完整性，也归一成内部 arguments 字符串
        let args = b.json || '{}';
        try {
          args = JSON.stringify(JSON.parse(b.json || '{}'));
        } catch {
          /* 流被截断时保留原文，工具层的 JSON.parse 会兜底报错 */
        }
        return {
          id: b.id || `toolu_${i}`,
          type: 'function' as const,
          function: { name: b.name, arguments: args },
        };
      });

    return {
      message: {
        role: 'assistant',
        content: text || null,
        ...(tool_calls.length > 0 ? { tool_calls } : {}),
      },
    };
  }
}

export default definePlugin({
  name: 'anthropic',
  kind: 'provider',
  matches: (baseUrl: string) => baseUrl.includes('/anthropic'),
  create: (config: Config) => new AnthropicProvider(config.baseUrl, config.apiKey, config.model),
});
