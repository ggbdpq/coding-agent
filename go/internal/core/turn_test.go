// 事件模型单测：turn 的规范事件序列（AgentEvent）是壳/审计/回放的公共契约。
// 锁死三件事：事件类型与顺序、turn_end 终态原因、断尾修复与事件的互不干扰
// （对齐 tcode/test/events.test.ts 四例）。
package core

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"gcode/internal/kernel"
)

// fakeStore 假会话存储：只记录 Append 调用。
type fakeStore struct {
	appended []kernel.ChatMessage
}

func (s *fakeStore) Start(meta map[string]any)   {}
func (s *fakeStore) Append(m kernel.ChatMessage) { s.appended = append(s.appended, m) }
func (s *fakeStore) ListRecent(n int) []kernel.SessionSummary {
	return nil
}
func (s *fakeStore) Load(file string) []kernel.ChatMessage { return nil }

// toolThenTextClient 要工具→拿到结果→出最终回答 的两段式假客户端（onText 由假客户端调用）。
func toolThenTextClient() kernel.ChatClient {
	return fakeChat(func(ctx context.Context, messages []kernel.ChatMessage, opts kernel.ChatOptions) (kernel.CompletionResult, error) {
		hasTool := false
		for _, m := range messages {
			if m.Role == "tool" {
				hasTool = true
			}
		}
		if !hasTool {
			return kernel.CompletionResult{Message: kernel.ChatMessage{
				Role: "assistant",
				ToolCalls: []kernel.ToolCall{{
					ID: "c1", Type: "function",
					Function: kernel.ToolCallFunction{Name: "fake", Arguments: "{}"},
				}},
			}}, nil
		}
		if opts.OnText != nil {
			opts.OnText("完成")
		}
		return kernel.CompletionResult{Message: kernel.ChatMessage{Role: "assistant", Content: kernel.StrPtr("完成")}}, nil
	})
}

// fakeChat 函数适配器：闭包 → ChatClient。
type fakeChat func(ctx context.Context, messages []kernel.ChatMessage, opts kernel.ChatOptions) (kernel.CompletionResult, error)

func (f fakeChat) Chat(ctx context.Context, messages []kernel.ChatMessage, opts kernel.ChatOptions) (kernel.CompletionResult, error) {
	return f(ctx, messages, opts)
}

var fakeTool = &kernel.ToolDef{
	Name:            "fake",
	Description:     "",
	Parameters:      map[string]any{"type": "object", "properties": map[string]any{}},
	NeedsPermission: false,
	Preview:         func(args map[string]any) string { return "" },
	Run:             func(context.Context, map[string]any) string { return "工具结果" },
}

func fakeTurnApp(provider kernel.ChatClient, store *fakeStore) *kernel.App {
	registry := kernel.NewRegistry()
	if err := registry.Register(kernel.Plugin{Tool: fakeTool}); err != nil {
		panic(err)
	}
	return &kernel.App{
		Config:   &kernel.Config{ContextLimit: 1_000_000},
		Registry: registry,
		Provider: provider,
		Store:    store,
		Yolo:     &kernel.YoloRef{Value: true},
		Messages: nil,
	}
}

// eventCollector 事件收集器：Emit 即 TurnHooks.Emit。
type eventCollector struct {
	list []kernel.AgentEvent
}

func (c *eventCollector) emit(ev kernel.AgentEvent) { c.list = append(c.list, ev) }

func TestTurnEventsCanonicalSequence(t *testing.T) {
	store := &fakeStore{}
	app := fakeTurnApp(toolThenTextClient(), store)
	var events eventCollector

	if err := RunUserTurn(context.Background(), app, "做事", TurnHooks{Emit: events.emit}); err != nil {
		t.Fatalf("turn 不应报错：%v", err)
	}

	types := make([]string, 0, len(events.list))
	for _, ev := range events.list {
		types = append(types, ev.Type)
	}
	want := []string{"turn_start", "user", "tool_call", "tool_result", "text_delta", "turn_end"}
	if !reflect.DeepEqual(types, want) {
		t.Fatalf("事件序列不符：got %v want %v", types, want)
	}
	if events.list[0].ID == "" {
		t.Fatalf("turn_start 应携带非空 id")
	}
	call := events.list[2]
	if call.CallID != "c1" || call.Name != "fake" {
		t.Fatalf("tool_call 应携带 call_id=c1 name=fake，got %+v", call)
	}
	result := events.list[3]
	if result.Summary != "工具结果" {
		t.Fatalf("tool_result 摘要应为首行文本，got %q", result.Summary)
	}
	end := events.list[len(events.list)-1]
	if end.Reason != kernel.TurnCompleted {
		t.Fatalf("turn_end reason 应为 completed，got %q", end.Reason)
	}
	// 会话落盘与事件不冲突：user + assistant + tool + assistant 四条
	if len(store.appended) != 4 {
		t.Fatalf("应落盘 4 条消息，got %d", len(store.appended))
	}
}

func TestTurnEventsAborted(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	app := fakeTurnApp(fakeChat(func(ctx context.Context, _ []kernel.ChatMessage, _ kernel.ChatOptions) (kernel.CompletionResult, error) {
		<-ctx.Done()
		return kernel.CompletionResult{}, ctx.Err()
	}), &fakeStore{})
	var events eventCollector

	cancel()
	err := RunUserTurn(ctx, app, "做事", TurnHooks{Emit: events.emit})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("中止错误应上抛，got %v", err)
	}
	end := events.list[len(events.list)-1]
	if end.Type != "turn_end" || end.Reason != kernel.TurnAborted {
		t.Fatalf("turn_end reason 应为 aborted，got %+v", end)
	}
}

func TestTurnEventsError(t *testing.T) {
	app := fakeTurnApp(fakeChat(func(context.Context, []kernel.ChatMessage, kernel.ChatOptions) (kernel.CompletionResult, error) {
		return kernel.CompletionResult{}, errors.New("网络炸了")
	}), &fakeStore{})
	var events eventCollector

	err := RunUserTurn(context.Background(), app, "做事", TurnHooks{Emit: events.emit})
	if err == nil || err.Error() != "网络炸了" {
		t.Fatalf("错误应原样上抛，got %v", err)
	}
	end := events.list[len(events.list)-1]
	if end.Type != "turn_end" || end.Reason != kernel.TurnError {
		t.Fatalf("turn_end reason 应为 error，got %+v", end)
	}
	if end.Error != "网络炸了" {
		t.Fatalf("turn_end 应携带错误消息，got %q", end.Error)
	}
}

func TestTurnEventsDanglingFixStillPersists(t *testing.T) {
	first := true
	store := &fakeStore{}
	app := fakeTurnApp(fakeChat(func(ctx context.Context, _ []kernel.ChatMessage, _ kernel.ChatOptions) (kernel.CompletionResult, error) {
		if first {
			first = false
			return kernel.CompletionResult{Message: kernel.ChatMessage{
				Role: "assistant",
				ToolCalls: []kernel.ToolCall{{
					ID: "c1", Type: "function",
					Function: kernel.ToolCallFunction{Name: "fake", Arguments: "{}"},
				}},
			}}, nil
		}
		return kernel.CompletionResult{}, context.Canceled
	}), store)
	var events eventCollector

	err := RunUserTurn(context.Background(), app, "做事", TurnHooks{Emit: events.emit})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("中止错误应上抛，got %v", err)
	}
	roles := make([]string, 0, len(app.Messages))
	for _, m := range app.Messages {
		roles = append(roles, m.Role)
	}
	// user → assistant(tool_call) → tool → 无悬空调用
	want := []string{"user", "assistant", "tool"}
	if !reflect.DeepEqual(roles, want) {
		t.Fatalf("消息角色序列不符：got %v want %v", roles, want)
	}
	if len(store.appended) < 3 {
		t.Fatalf("断尾修复后的消息也应落盘，got %d", len(store.appended))
	}
	end := events.list[len(events.list)-1]
	if end.Reason != kernel.TurnAborted {
		t.Fatalf("turn_end reason 应为 aborted，got %q", end.Reason)
	}
}
