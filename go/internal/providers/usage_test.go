// R5 usage 事件单测：openai 的 stream_options.include_usage 请求字段与 usage 分片解析、
// anthropic 的 message_start/message_delta usage 解析（触发 ChatOptions.OnUsage）。
package providers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"gcode/internal/kernel"
)

func sseResponse(w http.ResponseWriter, events ...string) {
	w.Header().Set("content-type", "text/event-stream")
	for _, e := range events {
		io.WriteString(w, "data: "+e+"\n\n") //nolint:errcheck
	}
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}

func TestOpenAIUsageCallback(t *testing.T) {
	var reqBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		reqBody = string(raw)
		sseResponse(w,
			`{"choices":[{"delta":{"content":"你好"}}]}`,
			`{"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":3}}`,
			`[DONE]`)
	}))
	defer srv.Close()

	var got []kernel.Usage
	p := NewOpenAI(srv.URL, "k", "m")
	_, err := p.Chat(context.Background(), []kernel.ChatMessage{{Role: "user", Content: kernel.StrPtr("hi")}},
		kernel.ChatOptions{OnUsage: func(u kernel.Usage) { got = append(got, u) }})
	if err != nil {
		t.Fatalf("chat 不应报错：%v", err)
	}
	if !strings.Contains(reqBody, `"stream_options":{"include_usage":true}`) {
		t.Fatalf("请求体缺 stream_options.include_usage：%s", reqBody)
	}
	if len(got) != 1 || got[0].PromptTokens != 20 || got[0].CompletionTokens != 3 {
		t.Fatalf("usage 回调应收到 {20 3}，got %+v", got)
	}
}

func TestAnthropicUsageCallback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sseResponse(w,
			`{"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0}}}`,
			`{"type":"content_block_start","index":0,"content_block":{"type":"text"}}`,
			`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}`,
			`{"type":"content_block_stop","index":0}`,
			`{"type":"message_delta","usage":{"output_tokens":9}}`,
			`{"type":"message_stop"}`)
	}))
	defer srv.Close()

	var got []kernel.Usage
	p := NewAnthropic(srv.URL, "k", "m")
	_, err := p.Chat(context.Background(), []kernel.ChatMessage{{Role: "user", Content: kernel.StrPtr("hi")}},
		kernel.ChatOptions{OnUsage: func(u kernel.Usage) { got = append(got, u) }})
	if err != nil {
		t.Fatalf("chat 不应报错：%v", err)
	}
	var sawInput, sawOutput bool
	for _, u := range got {
		if u.PromptTokens == 7 {
			sawInput = true
		}
		if u.CompletionTokens == 9 {
			sawOutput = true
		}
	}
	if !sawInput || !sawOutput {
		t.Fatalf("应分别收到 message_start 的 input_tokens=7 与 message_delta 的 output_tokens=9，got %+v", got)
	}
	if len(got) > 2 {
		t.Fatalf("usage 回调至多两次（start/delta），got %d 次：%v", len(got), got)
	}
}

// 请求体 sanity：marshal 出的 JSON 能被 roundtrip（防止手写线格式字段名拼错）。
func TestOpenAIRequestJSONShape(t *testing.T) {
	b, err := json.Marshal(openaiRequest{
		Model: "m", Stream: true,
		StreamOptions: &openaiStreamOptions{IncludeUsage: true},
	})
	if err != nil {
		t.Fatalf("marshal 失败：%v", err)
	}
	var probe struct {
		Stream        bool `json:"stream"`
		StreamOptions *struct {
			IncludeUsage bool `json:"include_usage"`
		} `json:"stream_options"`
	}
	if json.Unmarshal(b, &probe) != nil || !probe.Stream || probe.StreamOptions == nil || !probe.StreamOptions.IncludeUsage {
		t.Fatalf("请求体形状不符：%s", b)
	}
}
