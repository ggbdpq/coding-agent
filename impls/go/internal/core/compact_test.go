// compact 单测：摘要替换历史、失败永不破坏会话（对齐 tcode/test/compact.test.ts 四例）。
package core

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"gcode/internal/kernel"
)

func summarizerClient() kernel.ChatClient {
	return fakeChat(func(_ context.Context, _ []kernel.ChatMessage, opts kernel.ChatOptions) (kernel.CompletionResult, error) {
		if opts.OnText != nil {
			opts.OnText("这是摘要")
		}
		return kernel.CompletionResult{Message: kernel.ChatMessage{Role: "assistant", Content: kernel.StrPtr("这是摘要")}}, nil
	})
}

func historyMessages() []kernel.ChatMessage {
	msgs := []kernel.ChatMessage{{Role: "system", Content: kernel.StrPtr("系统提示")}}
	for i := 0; i < 10; i++ {
		msgs = append(msgs,
			kernel.ChatMessage{Role: "user", Content: kernel.StrPtr("问题 " + string(rune('0'+i)))},
			kernel.ChatMessage{Role: "assistant", Content: kernel.StrPtr("回答 " + string(rune('0'+i)))},
		)
	}
	return msgs
}

func fakeCompactApp(provider kernel.ChatClient, messages []kernel.ChatMessage) *kernel.App {
	return &kernel.App{
		Config:   &kernel.Config{ContextLimit: 1_000_000},
		Registry: kernel.NewRegistry(),
		Provider: provider,
		Store:    &fakeStore{},
		Yolo:     &kernel.YoloRef{Value: true},
		Messages: messages,
	}
}

func TestCompactKeepsRecentTail(t *testing.T) {
	messages := historyMessages()
	app := fakeCompactApp(summarizerClient(), messages)
	before := len(app.Messages)

	saved, err := CompactContext(app, CompactOpts{})
	if err != nil {
		t.Fatalf("compact 不应报错：%v", err)
	}
	if saved <= 0 {
		t.Fatalf("savedTokens 应 > 0，got %d", saved)
	}
	// system + 摘要 + 最近 4 条原文
	if len(app.Messages) != 6 {
		t.Fatalf("应为 system + 摘要 + 最近 4 条共 6 条，got %d", len(app.Messages))
	}
	if app.Messages[0].Role != "system" || app.Messages[0].Text() != "系统提示" {
		t.Fatalf("system 消息应原样保留，got %+v", app.Messages[0])
	}
	if !strings.Contains(app.Messages[1].Text(), "这是摘要") {
		t.Fatalf("摘要消息应含模型摘要，got %q", app.Messages[1].Text())
	}
	// 尾部从 user 边界开始，内容与原历史末尾 4 条一致
	if app.Messages[2].Role != "user" {
		t.Fatalf("尾部应从 user 消息开始，got %q", app.Messages[2].Role)
	}
	if !reflect.DeepEqual(app.Messages[2:], messages[len(messages)-4:]) {
		t.Fatalf("尾部 4 条应与原历史末尾一致：got %+v", app.Messages[2:])
	}
	if before <= len(app.Messages) {
		t.Fatalf("消息条数应减少：before=%d after=%d", before, len(app.Messages))
	}
}

func TestCompactTailStartSkipsToolBoundary(t *testing.T) {
	// 构造理想切点（len-4=6）恰为 tool 消息的历史：
	// 0 system,1 user,2 assistant(tc),3 tool,4 user,5 assistant(tc),6 tool,7 user,8 assistant,9 user
	toolCall := func(id string) []kernel.ToolCall {
		return []kernel.ToolCall{{
			ID: id, Type: "function",
			Function: kernel.ToolCallFunction{Name: "bash", Arguments: "{}"},
		}}
	}
	messages := []kernel.ChatMessage{
		{Role: "system", Content: kernel.StrPtr("系统提示")},
		{Role: "user", Content: kernel.StrPtr("u1")},
		{Role: "assistant", ToolCalls: toolCall("c1")},
		{Role: "tool", ToolCallID: "c1", Content: kernel.StrPtr("r1")},
		{Role: "user", Content: kernel.StrPtr("u2")},
		{Role: "assistant", ToolCalls: toolCall("c2")},
		{Role: "tool", ToolCallID: "c2", Content: kernel.StrPtr("r2")},
		{Role: "user", Content: kernel.StrPtr("u3")},
		{Role: "assistant", Content: kernel.StrPtr("a3")},
		{Role: "user", Content: kernel.StrPtr("u4")},
	}
	app := fakeCompactApp(summarizerClient(), messages)

	if _, err := CompactContext(app, CompactOpts{}); err != nil {
		t.Fatalf("compact 不应报错：%v", err)
	}
	// 切点不能落在 tool 上（配对安全）：向后扫到 idx7 的 user，尾部只保 3 条
	if len(app.Messages) != 5 {
		t.Fatalf("应为 system + 摘要 + 3 条尾部共 5 条，got %d", len(app.Messages))
	}
	if app.Messages[2].Text() != "u3" {
		t.Fatalf("尾部应从 u3 开始，got %q", app.Messages[2].Text())
	}
	// 摘要区已展平，结果里不残留 tool 消息
	for _, m := range app.Messages {
		if m.Role == "tool" {
			t.Fatalf("压缩结果不应残留 tool 消息（tool_call 配对被打断）")
		}
	}
}

func TestCompactRejectsShortHistory(t *testing.T) {
	messages := []kernel.ChatMessage{
		{Role: "system", Content: kernel.StrPtr("s")},
		{Role: "user", Content: kernel.StrPtr("a")},
		{Role: "assistant", Content: kernel.StrPtr("b")},
	}
	app := fakeCompactApp(summarizerClient(), messages)

	_, err := CompactContext(app, CompactOpts{})
	if err == nil || !strings.Contains(err.Error(), "没什么可压缩") {
		t.Fatalf("应拒绝过短历史，got %v", err)
	}
	if len(app.Messages) != 3 {
		t.Fatalf("拒绝后原历史应保持原状，got %d 条", len(app.Messages))
	}
}

func TestCompactFailureKeepsHistory(t *testing.T) {
	messages := historyMessages()
	snapshot := append([]kernel.ChatMessage(nil), messages...)
	app := fakeCompactApp(fakeChat(func(context.Context, []kernel.ChatMessage, kernel.ChatOptions) (kernel.CompletionResult, error) {
		return kernel.CompletionResult{}, errors.New("网络炸了")
	}), messages)

	_, err := CompactContext(app, CompactOpts{})
	if err == nil || !strings.Contains(err.Error(), "网络炸了") {
		t.Fatalf("应上抛网络错误，got %v", err)
	}
	if !reflect.DeepEqual(app.Messages, snapshot) {
		t.Fatalf("摘要失败后原历史应原封不动")
	}
}

func TestCompactCancelKeepsHistory(t *testing.T) {
	messages := historyMessages()
	ctx, cancel := context.WithCancel(context.Background())
	app := fakeCompactApp(fakeChat(func(ctx context.Context, _ []kernel.ChatMessage, _ kernel.ChatOptions) (kernel.CompletionResult, error) {
		<-ctx.Done()
		return kernel.CompletionResult{}, ctx.Err()
	}), messages)

	cancel()
	_, err := CompactContext(app, CompactOpts{Ctx: ctx})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("取消应上抛，got %v", err)
	}
	if len(app.Messages) != 21 {
		t.Fatalf("取消后原历史应原封不动，got %d 条", len(app.Messages))
	}
}
