// 共享词汇表：两种协议与核心逻辑共同依赖的线格式类型。
// 放 kernel 是因为 core/providers/session 都要引用，且不含任何行为。
package kernel

import "context"

// Protocol 协议名（GCODE_PROTOCOL 只认这两个值）。
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

// Usage 一次补全的 token 用量（provider 从协议流里解析，R5）。
type Usage struct {
	PromptTokens     int
	CompletionTokens int
}

// ChatOptions 单次补全的可选项。
type ChatOptions struct {
	Tools  []ToolSchema
	OnText func(delta string) // 正文增量回调（工具调用参数不走这里）
	// OnUsage token 用量回调（R5）：openai 由 stream_options.include_usage 的
	// usage 分片触发；anthropic 来自 message_start/message_delta。无用量不触发。
	OnUsage func(usage Usage)
}

// ChatClient 两种协议客户端的共同形状：agentloop 只认这个。
// ctx 首参贯穿取消链：HTTP 请求、SSE 读循环、重试退避全部响应中断。
type ChatClient interface {
	Chat(ctx context.Context, messages []ChatMessage, opts ChatOptions) (CompletionResult, error)
}

// TurnEndReason turn 终态原因：completed=模型收尾；aborted=用户中止；error=异常。
type TurnEndReason string

const (
	TurnCompleted TurnEndReason = "completed"
	TurnAborted   TurnEndReason = "aborted"
	TurnError     TurnEndReason = "error"
)

// 规范事件类型（AgentEvent.Type 的全部取值）。
const (
	EvTurnStart  = "turn_start"
	EvUser       = "user"
	EvTextDelta  = "text_delta"
	EvToolCall   = "tool_call"
	EvToolResult = "tool_result"
	EvPermission = "permission"
	EvTrimmed    = "trimmed"
	EvCompact    = "compact"
	EvUsage      = "usage"
	EvTurnEnd    = "turn_end"
)

// AgentEvent 规范事件流（v1 事件模型）：turn 是唯一生产者，壳/审计/回放是消费者。
// Go 无判别联合，用扁平 struct + Type 判别；每个事件只读与自己类型相关的字段：
//
//	turn_start{ID} user{Text} text_delta{Delta}
//	tool_call{CallID,Name,Args} tool_result{CallID,Name,Summary,Ms}
//	permission{ID,Name,Preview} trimmed{Count} compact{SavedTokens}
//	usage{PromptTokens,CompletionTokens}（R5 接入，先占位契约）
//	turn_end{Reason,Error}
type AgentEvent struct {
	Type string
	ID   string // turn_start 的 uuid / permission 的询问 id
	Text string // user 的原文
	// text_delta 正文增量
	Delta string
	// tool_call / tool_result / permission 共用
	CallID  string
	Name    string
	Args    map[string]any
	Summary string // tool_result：结果首行摘要
	Ms      int    // tool_result：执行耗时毫秒
	Preview string // permission：确认预览
	// trimmed 省略条数 / compact 节省估算
	Count       int
	SavedTokens int
	// usage token 用量（R5：provider 解析协议流后经 agentloop/turn 转成事件）
	PromptTokens     int
	CompletionTokens int
	// turn_end 终态
	Reason TurnEndReason
	Error  string // error 终态时的错误消息
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
