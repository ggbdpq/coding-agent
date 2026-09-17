// OpenAI 兼容 /chat/completions 客户端 + 对应 provider 插件（兜底：Matches 恒真）。
// 只支持流式——coding agent 的体感底线，也顺便让工具调用前的等待可见。
// SSE 手写解析：bufio 逐行接水，按 \n\n 分事件；tool_calls 按 index 分槽拼装 arguments 碎片。
package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

	"gocode/internal/kernel"
)

// OpenAIProvider OpenAI 兼容协议客户端。
type OpenAIProvider struct {
	baseURL string
	apiKey  string
	model   string
	client  *http.Client
}

// NewOpenAI 构造客户端。
func NewOpenAI(baseURL, apiKey, model string) *OpenAIProvider {
	return &OpenAIProvider{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		model:   model,
		client:  &http.Client{},
	}
}

// openaiRequest /chat/completions 请求体。
type openaiRequest struct {
	Model    string               `json:"model"`
	Messages []kernel.ChatMessage `json:"messages"`
	Tools    []kernel.ToolSchema  `json:"tools,omitempty"`
	Stream   bool                 `json:"stream"`
}

// openaiChunk 流式响应分片的形状（只取关心的字段）。
type openaiChunk struct {
	Choices []struct {
		Delta struct {
			Content   string `json:"content"`
			ToolCalls []struct {
				Index    int    `json:"index"`
				ID       string `json:"id"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
	} `json:"choices"`
}

type callSlot struct {
	id   string
	name string
	args string
}

// Chat 最多 3 次尝试；仅首字节前可重试（流已开始的中断不重试，避免内容重复）。
func (p *OpenAIProvider) Chat(ctx context.Context, messages []kernel.ChatMessage, opts kernel.ChatOptions) (kernel.CompletionResult, error) {
	return WithRetry(ctx, func() (kernel.CompletionResult, error) {
		return p.attempt(ctx, messages, opts)
	})
}

func (p *OpenAIProvider) attempt(ctx context.Context, messages []kernel.ChatMessage, opts kernel.ChatOptions) (kernel.CompletionResult, error) {
	body, err := json.Marshal(openaiRequest{Model: p.model, Messages: messages, Tools: opts.Tools, Stream: true})
	if err != nil {
		return kernel.CompletionResult{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return kernel.CompletionResult{}, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+p.apiKey)

	resp, err := p.client.Do(req)
	if err != nil {
		return kernel.CompletionResult{}, err // 网络层错误（url.Error 是 net.Error，可重试；ctx 取消不重试）
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return kernel.CompletionResult{}, httpStatusError(resp, true, 500)
	}

	// 流式增量装配：正文直接累加；工具调用按 index 分槽拼装碎片
	var content strings.Builder
	calls := map[int]*callSlot{}
	for data := range SSEData(resp.Body) {
		if data == "[DONE]" {
			break
		}
		var chunk openaiChunk
		if json.Unmarshal([]byte(data), &chunk) != nil {
			continue // 非 JSON 行（注释、心跳）直接跳过
		}
		if len(chunk.Choices) == 0 {
			continue
		}
		delta := chunk.Choices[0].Delta
		if delta.Content != "" {
			content.WriteString(delta.Content)
			if opts.OnText != nil {
				opts.OnText(delta.Content)
			}
		}
		for _, tc := range delta.ToolCalls {
			slot := calls[tc.Index]
			if slot == nil {
				slot = &callSlot{}
				calls[tc.Index] = slot
			}
			if tc.ID != "" {
				slot.id = tc.ID
			}
			if tc.Function.Name != "" {
				slot.name += tc.Function.Name
			}
			if tc.Function.Arguments != "" {
				slot.args += tc.Function.Arguments
			}
		}
	}

	indexes := make([]int, 0, len(calls))
	for i := range calls {
		indexes = append(indexes, i)
	}
	sort.Ints(indexes)
	var toolCalls []kernel.ToolCall
	for _, i := range indexes {
		s := calls[i]
		id := s.id
		if id == "" {
			id = fmt.Sprintf("call_%d", i)
		}
		args := s.args
		if args == "" {
			args = "{}"
		}
		toolCalls = append(toolCalls, kernel.ToolCall{
			ID:       id,
			Type:     "function",
			Function: kernel.ToolCallFunction{Name: s.name, Arguments: args},
		})
	}

	msg := kernel.ChatMessage{Role: "assistant", Content: nilOrText(content.String()), ToolCalls: toolCalls}
	return kernel.CompletionResult{Message: msg}, nil
}

// nilOrText 空串 → nil（线格式 content:null，对齐 tcode 的 `content || null`）。
func nilOrText(s string) *string {
	if s == "" {
		return nil
	}
	return kernel.StrPtr(s)
}

// httpStatusError 非 2xx 响应 → 错误；min429/min5xx 及以上的状态码标记可重试。
func httpStatusError(resp *http.Response, retry429 bool, retry5xx int) error {
	brief := ""
	if data, err := io.ReadAll(io.LimitReader(resp.Body, 4096)); err == nil {
		brief = string(data)
	}
	if r := []rune(brief); len(r) > 300 {
		brief = string(r[:300]) + "…"
	}
	msg := fmt.Sprintf("HTTP %d：%s", resp.StatusCode, brief)
	retryable := (retry429 && resp.StatusCode == 429) || resp.StatusCode >= retry5xx
	if retryable {
		return &RetryableError{msg}
	}
	return errors.New(msg)
}

// OpenAIPlugin provider 插件：Matches 恒真，是兜底——清单里必须排在 provider 类的最后。
var OpenAIPlugin = &kernel.ProviderDef{
	Name:    "openai",
	Matches: func(string) bool { return true },
	Create: func(config *kernel.Config) kernel.ChatClient {
		return NewOpenAI(config.BaseURL, config.APIKey, config.Model)
	},
}
