// Plan Mode 单测：开启时写类工具被拒（引导产出计划）、读类工具不受影响、关闭恢复
// （对齐 tcode/test/planmode.test.ts）。
package core

import (
	"context"
	"strings"
	"testing"

	"gcode/internal/kernel"
)

// planModeTools write（写类，记录是否真的执行过）与 read（读类）两个测试工具。
func planModeTools() (write, read *kernel.ToolDef, ranWrite *bool) {
	ranWrite = new(bool)
	write = &kernel.ToolDef{
		Name:            "write",
		Parameters:      map[string]any{"type": "object", "properties": map[string]any{}},
		NeedsPermission: true,
		Preview:         func(map[string]any) string { return "" },
		Run: func(context.Context, map[string]any) string {
			*ranWrite = true
			return "已写入"
		},
	}
	read = &kernel.ToolDef{
		Name:            "read",
		Parameters:      map[string]any{"type": "object", "properties": map[string]any{}},
		NeedsPermission: false,
		Preview:         func(map[string]any) string { return "" },
		Run:             func(context.Context, map[string]any) string { return "文件内容" },
	}
	return write, read, ranWrite
}

// planModeClient 假客户端：第一轮要 write、第二轮要 read、之后出最终文本。
func planModeClient() kernel.ChatClient {
	n := 0
	return fakeChat(func(_ context.Context, _ []kernel.ChatMessage, opts kernel.ChatOptions) (kernel.CompletionResult, error) {
		n++
		if n == 1 || n == 2 {
			name := "read"
			if n == 1 {
				name = "write"
			}
			return kernel.CompletionResult{Message: kernel.ChatMessage{
				Role: "assistant",
				ToolCalls: []kernel.ToolCall{{
					ID: "c" + string(rune('0'+n)), Type: "function",
					Function: kernel.ToolCallFunction{Name: name, Arguments: "{}"},
				}},
			}}, nil
		}
		if opts.OnText != nil {
			opts.OnText("完成")
		}
		return kernel.CompletionResult{Message: kernel.ChatMessage{Role: "assistant", Content: kernel.StrPtr("完成")}}, nil
	})
}

func planModeApp(planOn bool) (*kernel.App, *bool) {
	write, read, ranWrite := planModeTools()
	registry := kernel.NewRegistry()
	if err := registry.Register(kernel.Plugin{Tool: write}); err != nil {
		panic(err)
	}
	if err := registry.Register(kernel.Plugin{Tool: read}); err != nil {
		panic(err)
	}
	app := &kernel.App{
		Config:   &kernel.Config{ContextLimit: 1_000_000},
		Registry: registry,
		Provider: planModeClient(),
		Store:    &fakeStore{},
		Yolo:     &kernel.YoloRef{Value: true},
		PlanMode: &kernel.YoloRef{Value: planOn},
	}
	return app, ranWrite
}

func toolResults(events []kernel.AgentEvent) []kernel.AgentEvent {
	var out []kernel.AgentEvent
	for _, ev := range events {
		if ev.Type == kernel.EvToolResult {
			out = append(out, ev)
		}
	}
	return out
}

func TestPlanModeOnDeniesWriteAllowsRead(t *testing.T) {
	app, ranWrite := planModeApp(true)
	var events eventCollector

	if err := RunUserTurn(context.Background(), app, "做个计划", TurnHooks{Emit: events.emit}); err != nil {
		t.Fatalf("turn 不应报错：%v", err)
	}

	results := toolResults(events.list)
	if len(results) < 2 {
		t.Fatalf("应有 write 与 read 两次工具回合，got %d", len(results))
	}
	var denied, readOK bool
	for _, r := range results {
		if r.Name == "write" && strings.Contains(r.Summary, "Plan Mode") {
			denied = true
		}
		if r.Name == "read" && strings.Contains(r.Summary, "文件内容") {
			readOK = true
		}
	}
	if !denied {
		t.Fatalf("write 应被 Plan Mode 拒绝（tool 结果含 Plan Mode）")
	}
	if !readOK {
		t.Fatalf("read 不受影响，应正常返回文件内容")
	}
	if *ranWrite {
		t.Fatalf("Plan Mode 下 write 不得真的执行")
	}
}

func TestPlanModeOffWriteRuns(t *testing.T) {
	app, ranWrite := planModeApp(false)
	var events eventCollector

	if err := RunUserTurn(context.Background(), app, "直接写", TurnHooks{Emit: events.emit}); err != nil {
		t.Fatalf("turn 不应报错：%v", err)
	}

	var writeOK bool
	for _, r := range toolResults(events.list) {
		if r.Name == "write" && strings.Contains(r.Summary, "已写入") {
			writeOK = true
		}
	}
	if !writeOK || !*ranWrite {
		t.Fatalf("关闭 Plan Mode 后 write 应正常执行")
	}
}
