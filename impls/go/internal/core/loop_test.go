// 工具循环单测：40 轮熔断（带工具请求次数口径），熔断后不带工具再请求一次强制总结
// （对齐 typescript/test/loop.test.ts；循环契约见 agentloop.go 与 MaxToolRounds 常量）。
package core

import (
	"context"
	"testing"

	"gcode/internal/kernel"
)

func TestLoopCircuitBreaker40Rounds(t *testing.T) {
	calls := 0
	client := fakeChat(func(ctx context.Context, messages []kernel.ChatMessage, opts kernel.ChatOptions) (kernel.CompletionResult, error) {
		calls++
		if calls <= 40 {
			return kernel.CompletionResult{Message: kernel.ChatMessage{
				Role: "assistant",
				ToolCalls: []kernel.ToolCall{{
					ID: "c1", Type: "function",
					Function: kernel.ToolCallFunction{Name: "fake", Arguments: "{}"},
				}},
			}}, nil
		}
		if opts.OnText != nil {
			opts.OnText("总结")
		}
		return kernel.CompletionResult{Message: kernel.ChatMessage{Role: "assistant", Content: kernel.StrPtr("总结")}}, nil
	})
	store := &fakeStore{}
	app := fakeTurnApp(client, store)
	var events eventCollector

	err := RunUserTurn(context.Background(), app, "做事", TurnHooks{Emit: events.emit})
	if err != nil {
		t.Fatalf("熔断总结后应正常收尾，got %v", err)
	}
	if calls != 41 {
		t.Fatalf("应恰好 40 次带工具请求 + 1 次无工具总结，got %d", calls)
	}
	if len(app.Messages) != 82 {
		t.Fatalf("user + 40×(assistant+tool) + 总结 = 82 条，got %d", len(app.Messages))
	}
	end := events.list[len(events.list)-1]
	if end.Type != "turn_end" || end.Reason != kernel.TurnCompleted {
		t.Fatalf("终态应为 completed，got %+v", end)
	}
}
