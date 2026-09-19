// Anthropic Messages 协议客户端（POST {baseUrl}/v1/messages）+ provider 插件：
// 服务于 Claude 官方 API、DeepSeek /anthropic 端点及同类兼容中转。
// 消息映射：system 提为顶层参数；tool 消息转为 user 角色的 tool_result 块；
// 相邻同角色消息合并（Anthropic 要求 user/assistant 严格交替）。
package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"gcode/internal/kernel"
)

// AnthropicVersion 协议版本头。
const AnthropicVersion = "2023-06-01"

// DefaultMaxTokens Anthropic 必填的 max_tokens。
const DefaultMaxTokens = 8192

// ToAnthropicRequest 内部（OpenAI 形状）消息 → Anthropic 请求体。
// 纯函数，块用 map 表达（避免 omitempty 吞掉 "input":{}）。
func ToAnthropicRequest(messages []kernel.ChatMessage, model string, maxTokens int, tools []kernel.ToolSchema) map[string]any {
	var system []string
	type flatMsg struct {
		role    string
		content []map[string]any
	}
	var flat []flatMsg
	for _, m := range messages {
		switch m.Role {
		case "system":
			if m.Text() != "" {
				system = append(system, m.Text())
			}
		case "user":
			flat = append(flat, flatMsg{"user", []map[string]any{{"type": "text", "text": m.Text()}}})
		case "tool":
			flat = append(flat, flatMsg{"user", []map[string]any{{
				"type": "tool_result", "tool_use_id": m.ToolCallID, "content": m.Text(),
			}}})
		default: // assistant
			var blocks []map[string]any
			if m.Text() != "" {
				blocks = append(blocks, map[string]any{"type": "text", "text": m.Text()})
			}
			for _, tc := range m.ToolCalls {
				var input any = map[string]any{}
				if raw := tc.Function.Arguments; raw != "" {
					var parsed any
					if json.Unmarshal([]byte(raw), &parsed) == nil && parsed != nil {
						input = parsed
					}
				}
				blocks = append(blocks, map[string]any{
					"type": "tool_use", "id": tc.ID, "name": tc.Function.Name, "input": input,
				})
			}
			flat = append(flat, flatMsg{"assistant", blocks})
		}
	}
	// 相邻同角色合并
	merged := make([]map[string]any, 0, len(flat))
	for _, m := range flat {
		if n := len(merged); n > 0 && merged[n-1]["role"] == m.role {
			prev := merged[n-1]["content"].([]map[string]any)
			merged[n-1]["content"] = append(prev, m.content...)
			continue
		}
		merged = append(merged, map[string]any{"role": m.role, "content": m.content})
	}

	body := map[string]any{
		"model":      model,
		"max_tokens": maxTokens,
		"messages":   merged,
		"stream":     true,
	}
	if len(system) > 0 {
		body["system"] = strings.Join(system, "\n")
	}
	if len(tools) > 0 {
		ts := make([]map[string]any, 0, len(tools))
		for _, t := range tools {
			ts = append(ts, map[string]any{
				"name":         t.Function.Name,
				"description":  t.Function.Description,
				"input_schema": t.Function.Parameters,
			})
		}
		body["tools"] = ts
	}
	return body
}

// anthroUsage usage 载荷：message_start 给 input/output 初值，message_delta 给累计 output。
type anthroUsage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

// anthroEvent 流式事件的形状（只取关心的字段）。
type anthroEvent struct {
	Type    string `json:"type"`
	Index   int    `json:"index"`
	Message *struct {
		Usage anthroUsage `json:"usage"`
	} `json:"message"`
	Usage        *anthroUsage `json:"usage"`
	ContentBlock struct {
		Type string `json:"type"`
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"content_block"`
	Delta struct {
		Type        string `json:"type"`
		Text        string `json:"text"`
		PartialJSON string `json:"partial_json"`
	} `json:"delta"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

type anthroSlot struct {
	id   string
	name string
	json string
}

// AnthropicProvider Anthropic Messages 协议客户端。
type AnthropicProvider struct {
	baseURL string
	apiKey  string
	model   string
	client  *http.Client
}

// NewAnthropic 构造客户端。
func NewAnthropic(baseURL, apiKey, model string) *AnthropicProvider {
	return &AnthropicProvider{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		model:   model,
		client:  &http.Client{},
	}
}

// Chat 与 OpenAI 版相同的重试纪律：最多 3 次，仅首字节前可重试。
func (p *AnthropicProvider) Chat(ctx context.Context, messages []kernel.ChatMessage, opts kernel.ChatOptions) (kernel.CompletionResult, error) {
	return WithRetry(ctx, func() (kernel.CompletionResult, error) {
		return p.attempt(ctx, messages, opts)
	})
}

func (p *AnthropicProvider) attempt(ctx context.Context, messages []kernel.ChatMessage, opts kernel.ChatOptions) (kernel.CompletionResult, error) {
	body, err := json.Marshal(ToAnthropicRequest(messages, p.model, DefaultMaxTokens, opts.Tools))
	if err != nil {
		return kernel.CompletionResult{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/v1/messages", bytes.NewReader(body))
	if err != nil {
		return kernel.CompletionResult{}, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-api-key", p.apiKey)
	req.Header.Set("authorization", "Bearer "+p.apiKey)
	req.Header.Set("anthropic-version", AnthropicVersion)

	resp, err := p.client.Do(req)
	if err != nil {
		return kernel.CompletionResult{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return kernel.CompletionResult{}, httpStatusError(resp, true, 500) // 529 也 >=500，一并可重试
	}

	// 事件装配：text_delta 累加正文；tool_use 块按 index 收 input_json_delta 碎片
	var text strings.Builder
	toolBlocks := map[int]*anthroSlot{}
	for data := range SSEData(ctx, resp.Body) {
		if err := ctx.Err(); err != nil {
			return kernel.CompletionResult{}, err // 流中用户中止：立即放弃，不返回半截消息
		}
		var ev anthroEvent
		if json.Unmarshal([]byte(data), &ev) != nil {
			continue
		}
		if ev.Type == "error" {
			return kernel.CompletionResult{}, errors.New("流内错误：" + orDefault(ev.Error, data))
		}
		if ev.Type == "content_block_start" && ev.ContentBlock.Type == "tool_use" {
			toolBlocks[ev.Index] = &anthroSlot{id: ev.ContentBlock.ID, name: ev.ContentBlock.Name}
			continue
		}
		if ev.Type == "content_block_delta" {
			switch ev.Delta.Type {
			case "text_delta":
				if ev.Delta.Text != "" {
					text.WriteString(ev.Delta.Text)
					if opts.OnText != nil {
						opts.OnText(ev.Delta.Text)
					}
				}
			case "input_json_delta":
				if b := toolBlocks[ev.Index]; b != nil && ev.Delta.PartialJSON != "" {
					b.json += ev.Delta.PartialJSON
				}
			}
		}
		// message_start/message_delta 携带 token 用量（R5：usage 进事件）
		if ev.Type == "message_start" || ev.Type == "message_delta" {
			u := ev.Usage
			if ev.Type == "message_start" && ev.Message != nil {
				u = &ev.Message.Usage
			}
			if u != nil && opts.OnUsage != nil && (u.InputTokens > 0 || u.OutputTokens > 0) {
				opts.OnUsage(kernel.Usage{PromptTokens: u.InputTokens, CompletionTokens: u.OutputTokens})
			}
		}
		// message_stop / ping：块拼完即返回，无需特殊处理
	}

	indexes := make([]int, 0, len(toolBlocks))
	for i := range toolBlocks {
		indexes = append(indexes, i)
	}
	sort.Ints(indexes)
	var toolCalls []kernel.ToolCall
	for _, i := range indexes {
		b := toolBlocks[i]
		// 解析一遍再序列化：既验证 JSON 完整性，也归一成内部 arguments 字符串
		args := b.json
		if args == "" {
			args = "{}"
		} else if normalized, err := json.Marshal(json.RawMessage(args)); err == nil {
			args = string(normalized)
		} // 流被截断时保留原文，工具层的参数解析会兜底报错
		id := b.id
		if id == "" {
			id = fmt.Sprintf("toolu_%d", i)
		}
		toolCalls = append(toolCalls, kernel.ToolCall{
			ID:       id,
			Type:     "function",
			Function: kernel.ToolCallFunction{Name: b.name, Arguments: args},
		})
	}

	msg := kernel.ChatMessage{Role: "assistant", Content: nilOrText(text.String()), ToolCalls: toolCalls}
	return kernel.CompletionResult{Message: msg}, nil
}

func orDefault(e *struct {
	Message string `json:"message"`
}, fallback string) string {
	if e != nil && e.Message != "" {
		return e.Message
	}
	return fallback
}

// AnthropicPlugin provider 插件：BASE_URL 含 /anthropic 时命中。
var AnthropicPlugin = &kernel.ProviderDef{
	Name:    "anthropic",
	Matches: func(baseUrl string) bool { return strings.Contains(baseUrl, "/anthropic") },
	Create: func(config *kernel.Config) kernel.ChatClient {
		return NewAnthropic(config.BaseURL, config.APIKey, config.Model)
	},
}
