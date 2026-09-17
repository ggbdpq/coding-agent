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
}

/** 两种协议客户端的共同形状：agentloop 只认这个 */
export interface ChatClient {
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<CompletionResult>;
}

/** 会话级 yolo 开关（--yolo 或 /yolo / 权限确认里的 a 都改它） */
export interface YoloRef {
  value: boolean;
}
