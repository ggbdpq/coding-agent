// 一轮用户输入的完整编排：裁剪 → 入列 → 工具循环 → 断尾修复 → 会话落盘。
// 所有壳共用这里，保证裁剪/落盘/修复语义全项目只有一份。
package core

import (
	"context"

	"gocode/internal/kernel"
)

// TurnHooks 壳侧回调。
type TurnHooks struct {
	// Check 权限闸门（needsPermission 的工具会被询问）；nil 视为全部放行
	Check func(toolName, preview string) bool
	// OnText 正文增量回调
	OnText func(delta string)
	// OnToolCall 工具开始执行前回调
	OnToolCall func(name string, args map[string]any)
	// OnToolResult 工具执行完回调（含拒绝与耗时）
	OnToolResult func(name, result string, ms int64)
	// OnTrimmed 上下文被裁剪时通知壳（REPL 打灰字）
	OnTrimmed func(count int)
}

// RunUserTurn 执行一轮用户输入；出错时先修复断尾再落盘，然后把错误交回壳展示。
func RunUserTurn(ctx context.Context, app *kernel.App, line string, hooks TurnHooks) error {
	// 轮前裁剪：只影响发给模型的上下文；会话文件里保留完整历史
	if cut := TrimContext(app.Messages, app.Config.ContextLimit); cut > 0 && hooks.OnTrimmed != nil {
		hooks.OnTrimmed(cut)
	}

	app.Messages = append(app.Messages, kernel.ChatMessage{Role: "user", Content: kernel.StrPtr(line)})
	mark := len(app.Messages) - 1
	appendSince := func() {
		for _, m := range app.Messages[mark:] {
			app.Store.Append(m)
		}
	}

	err := RunTurn(ctx, &app.Messages, TurnDeps{
		Provider:     app.Provider,
		Tools:        app.Registry.Tools(),
		Check:        hooks.Check,
		OnText:       hooks.OnText,
		OnToolCall:   hooks.OnToolCall,
		OnToolResult: hooks.OnToolResult,
	})
	if err != nil {
		// 出错可能留下"有工具调用、无回应"的断尾，补占位保证消息序列对 API 合法
		app.Messages = fixDanglingToolCalls(app.Messages)
		appendSince()
		return err
	}
	appendSince()
	return nil
}

// fixDanglingToolCalls 补齐"assistant 要了工具但没有回应"的断尾。
func fixDanglingToolCalls(messages []kernel.ChatMessage) []kernel.ChatMessage {
	if len(messages) == 0 {
		return messages
	}
	last := messages[len(messages)-1]
	if last.Role != "assistant" || len(last.ToolCalls) == 0 {
		return messages
	}
	answered := map[string]bool{}
	for _, m := range messages {
		if m.Role == "tool" {
			answered[m.ToolCallID] = true
		}
	}
	for _, tc := range last.ToolCalls {
		if !answered[tc.ID] {
			messages = append(messages, kernel.ChatMessage{
				Role:       "tool",
				ToolCallID: tc.ID,
				Content:    kernel.StrPtr("（用户中止，未执行）"),
			})
		}
	}
	return messages
}
