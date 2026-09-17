// 共享词汇表：两种协议与核心逻辑共同依赖的线格式类型。
// 放 kernel 是因为 core/providers/session 都要引用，且不含任何行为。
package kernel

import "context"

// Protocol 协议名（GOCODE_PROTOCOL 只认这两个值）。
type Protocol string

const (
	ProtocolOpenAI    Protocol = "openai"
	ProtocolAnthropic Protocol = "anthropic"
)

// ToolSchema function calling 的 tools 参数元素。
type ToolSchema struct {
	Type     string             `json:"type"`
	Function ToolSchemaFunction `json:"function"`
}

// ToolSchemaFunction ToolSchema 的 function 载荷。
type ToolSchemaFunction struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

// ToolCall assistant 消息里的工具调用。
type ToolCall struct {
	ID       string           `json:"id"`
	Type     string           `json:"type"`
	Function ToolCallFunction `json:"function"`
}

// ToolCallFunction ToolCall 的 function 载荷（arguments 是 JSON 字符串，两种协议通用）。
type ToolCallFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// ChatMessage 内部统一消息形状（OpenAI 线格式）；Anthropic 客户端负责换算。
// Content 用指针区分"没有正文"（nil→null）与空串。
type ChatMessage struct {
	Role       string     `json:"role"`
	Content    *string    `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

// Text 返回消息正文（nil 视为空串）。
func (m ChatMessage) Text() string {
	if m.Content == nil {
		return ""
	}
	return *m.Content
}

// StrPtr 便捷构造：字符串 → 指针。
func StrPtr(s string) *string { return &s }

// CompletionResult 一次补全的产物。
type CompletionResult struct {
	Message ChatMessage `json:"message"`
}

// ChatOptions 单次补全的可选项。
type ChatOptions struct {
	Tools  []ToolSchema
	OnText func(delta string) // 正文增量回调（工具调用参数不走这里）
}

// ChatClient 两种协议客户端的共同形状：agentloop 只认这个。
type ChatClient interface {
	Chat(ctx context.Context, messages []ChatMessage, opts ChatOptions) (CompletionResult, error)
}

// YoloRef 会话级免确认开关（--yolo、/yolo、权限确认里的 a 改的都是它）。
type YoloRef struct{ Value bool }

// SessionSummary 会话列表条目。
type SessionSummary struct {
	File  string
	Mtime int64 // 毫秒时间戳
	Label string
}

// SessionStoreLike core/session.SessionStore 满足此结构（kernel 不直接依赖 core）。
type SessionStoreLike interface {
	Start(meta map[string]any)
	Append(message ChatMessage)
	ListRecent(n int) []SessionSummary
	Load(file string) []ChatMessage
}
