// 共享词汇表：两种协议与核心逻辑共同依赖的线格式类型。
// 放 kernel 是因为 core/providers/session 都要引用，且不含任何行为。

export type Protocol = 'openai' | 'anthropic';

export interface ToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface CompletionResult {
  message: ChatMessage;
}

export interface ChatOptions {
  tools?: ToolSchema[];
  signal?: AbortSignal;
  /** 正文增量回调（工具调用参数不走这里） */
  onText?: (delta: string) => void;
  /** 每轮 token 用量（R5：usage 进事件） */
  onUsage?: (usage: { prompt_tokens: number; completion_tokens: number }) => void;
}

/** 两种协议客户端的共同形状：agentloop 只认这个 */
export interface ChatClient {
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<CompletionResult>;
}

/** turn 终态原因：completed=模型收尾；aborted=用户中止；error=异常 */
export type TurnEndReason = 'completed' | 'aborted' | 'error';

/**
 * 规范事件流（v1 事件模型，蓝图 §4.4）：turn 是唯一生产者，壳/审计/回放是消费者。
 * usage 变体在 R5 接入（provider 目前丢弃 usage，先占位契约）。
 */
export type AgentEvent =
  | { type: 'turn_start'; id: string }
  | { type: 'user'; text: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; call_id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; call_id: string; name: string; summary: string; ms: number }
  | { type: 'permission'; id: string; tool: string; preview: string }
  | { type: 'trimmed'; count: number }
  | { type: 'compact'; savedTokens: number }
  | { type: 'usage'; prompt_tokens: number; completion_tokens: number }
  | { type: 'turn_end'; reason: TurnEndReason; error?: string };

/** 会话级 yolo 开关（--yolo 或 /yolo / 权限确认里的 a 都改它） */
export interface YoloRef {
  value: boolean;
}
