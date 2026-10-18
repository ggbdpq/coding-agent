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
  /** 归一化结束原因（ADR-003/WP3）：providers 填充；缺省视为 'unknown'，旧 fake provider 无需修改 */
  finishReason?: FinishReason;
}

/** 归一化的结束原因：openai finish_reason / anthropic stop_reason 都映射到这里（映射表见 specs/provider.md） */
export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'unknown';

/** 工具参数错误的分类（ADR-003/WP3：参数非法不再静默变 {}） */
export type ToolErrorKind = 'invalid_args' | 'truncated_args' | 'unknown_tool' | 'schema_mismatch';

/** 上下文治理的发生时机：轮开始前，或轮内每次模型调用前 */
export type GovernanceAt = 'turn_start' | 'model_call';

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
  | { type: 'tool_result'; call_id: string; name: string; summary: string; output?: string; ms: number }
  | { type: 'permission'; id: string; tool: string; preview: string }
  | { type: 'trimmed'; count: number; at?: GovernanceAt }
  | { type: 'compact'; savedTokens: number; at?: GovernanceAt }
  | { type: 'context_edit'; strategy: 'clear_tool_outputs'; cleared: number; savedTokens: number; at: GovernanceAt }
  | { type: 'tool_error'; call_id: string; name: string; kind: ToolErrorKind; detail: string }
  | { type: 'limit'; kind: 'model_calls' | 'tool_calls'; limit: number; behavior: 'summarize' | 'end' }
  | { type: 'usage'; prompt_tokens: number; completion_tokens: number }
  | { type: 'turn_end'; reason: TurnEndReason; error?: string };

/** 会话级 yolo 开关（--yolo 或 /yolo / 权限确认里的 a 都改它） */
export interface YoloRef {
  value: boolean;
}
