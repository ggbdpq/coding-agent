// 上下文裁剪单测：裁旧留新 + 消息结构（assistant↔tool 配对）不被破坏（对齐 tcode/test/context.test.ts）。
package core

import (
	"strconv"
	"strings"
	"testing"

	"gcode/internal/kernel"
)

// exchange 构造一组 assistant(tool_call) + tool(大输出) 消息。
func exchange(i int, size int) []kernel.ChatMessage {
	id := "c" + strconv.Itoa(i)
	return []kernel.ChatMessage{
		{
			Role: "assistant",
			ToolCalls: []kernel.ToolCall{{
				ID:       id,
				Type:     "function",
				Function: kernel.ToolCallFunction{Name: "bash", Arguments: "{}"},
			}},
		},
		{Role: "tool", ToolCallID: id, Content: kernel.StrPtr(strings.Repeat("x", size))},
	}
}

func TestEstimateTokensGrows(t *testing.T) {
	small := []kernel.ChatMessage{{Role: "user", Content: kernel.StrPtr("hi")}}
	big := []kernel.ChatMessage{{Role: "user", Content: kernel.StrPtr(strings.Repeat("x", 3000))}}
	if EstimateTokens(big) <= EstimateTokens(small)*100 {
		t.Fatalf("估算应随内容增长：big=%d small=%d", EstimateTokens(big), EstimateTokens(small))
	}
}

func TestTrimContextNoopUnderLimit(t *testing.T) {
	messages := []kernel.ChatMessage{
		{Role: "system", Content: kernel.StrPtr("sys")},
	}
	messages = append(messages, exchange(0, 100)...)
	if n := TrimContext(messages, 1<<62); n != 0 {
		t.Fatalf("不超限不应裁剪，got %d", n)
	}
}

func TestTrimContextCutOldKeepRecent12(t *testing.T) {
	messages := []kernel.ChatMessage{
		{Role: "system", Content: kernel.StrPtr("sys")},
		{Role: "user", Content: kernel.StrPtr("hi")},
	}
	for i := 0; i < 30; i++ {
		messages = append(messages, exchange(i, 3000)...)
	}

	trimmed := TrimContext(messages, 5000)
	var tools []kernel.ChatMessage
	for _, m := range messages {
		if m.Role == "tool" {
			tools = append(tools, m)
		}
	}
	withPlaceholder := 0
	for _, m := range tools {
		if *m.Content == TrimPlaceholder {
			withPlaceholder++
		}
	}
	if trimmed != withPlaceholder {
		t.Fatalf("返回的被裁条数应与占位条数一致：trimmed=%d placeholder=%d", trimmed, withPlaceholder)
	}
	if trimmed != 18 {
		t.Fatalf("30 条工具消息保留最近 12 条，应裁最旧 18 条，got %d", trimmed)
	}
	for _, m := range tools[len(tools)-12:] {
		if *m.Content == TrimPlaceholder {
			t.Fatalf("最近 12 条不应被裁：%q", *m.Content)
		}
	}

	// API 合法性：每个 assistant 的 tool_call 后必须紧跟同 id 的 tool 回应
	for i := 0; i < len(messages); i++ {
		m := messages[i]
		if m.Role != "assistant" {
			continue
		}
		for _, tc := range m.ToolCalls {
			if i+1 >= len(messages) {
				t.Fatalf("消息 %d 的工具调用 %s 没有紧邻回应", i, tc.ID)
			}
			next := messages[i+1]
			if next.Role != "tool" || next.ToolCallID != tc.ID {
				t.Fatalf("消息 %d 的工具调用 %s 没有紧邻回应", i, tc.ID)
			}
		}
	}
}

func TestTrimContextIdempotent(t *testing.T) {
	messages := []kernel.ChatMessage{{Role: "system", Content: kernel.StrPtr("s")}}
	for i := 0; i < 20; i++ {
		messages = append(messages, exchange(i, 3000)...)
	}
	TrimContext(messages, 5000)
	if n := TrimContext(messages, 5000); n != 0 {
		t.Fatalf("占位消息不应被二次裁剪，got %d", n)
	}
}

func TestTrimContextSkipsEmptyContent(t *testing.T) {
	messages := []kernel.ChatMessage{
		{Role: "system", Content: kernel.StrPtr("sys")},
		{Role: "assistant", ToolCalls: []kernel.ToolCall{{
			ID:       "e",
			Type:     "function",
			Function: kernel.ToolCallFunction{Name: "bash", Arguments: "{}"},
		}}},
		{Role: "tool", ToolCallID: "e", Content: kernel.StrPtr("")},
	}
	for i := 0; i < 30; i++ {
		messages = append(messages, exchange(i, 3000)...)
	}

	if trimmed := TrimContext(messages, 5000); trimmed != 18 {
		t.Fatalf("只裁 30 条大输出中最旧 18 条，空内容不计，got %d", trimmed)
	}
	if *messages[2].Content != "" {
		t.Fatalf("空内容 tool 消息不应被替换，got %q", *messages[2].Content)
	}
}
