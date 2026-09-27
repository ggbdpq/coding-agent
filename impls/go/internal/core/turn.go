// 一轮用户输入的完整编排：治理（compact→trim 兜底）→ 入列 → 工具循环 → 断尾修复 → 会话落盘。
// 所有壳共用这里，保证治理/落盘/修复语义全项目只有一份。
// v1 事件模型：turn 是唯一生产者，通过 Emit 发出规范 AgentEvent（kernel/types），
// 壳只订阅不拼装——加功能=加事件类型，不动消费端接口。
package core

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"

	"gcode/internal/kernel"
)

// TurnHooks 壳侧回调。
type TurnHooks struct {
	// Check 权限闸门（needsPermission 的工具会被询问）；nil 视为全部放行
	Check func(toolName, preview string) bool
	// Emit 规范事件出口：壳渲染（REPL 直写）、审计与测试断言都消费它
	Emit func(ev kernel.AgentEvent)
}

// RunUserTurn 执行一轮用户输入；出错/中止时先修复断尾再落盘、发 turn_end 终态，
// 然后把错误交回壳展示（壳区分中止与出错）。
func RunUserTurn(ctx context.Context, app *kernel.App, line string, hooks TurnHooks) error {
	emit := func(ev kernel.AgentEvent) {
		if hooks.Emit != nil {
			hooks.Emit(ev)
		}
	}

	// 轮前上下文治理（双档）：估算超预算 80% 先试摘要压缩（保留任务目标与最近原文），
	// 压不动（失败/中止）再退裁剪（丢最旧工具输出兜底）
	if EstimateTokens(app.Messages) > int(float64(app.Config.ContextLimit)*0.8) {
		if saved, err := CompactContext(app, CompactOpts{Ctx: ctx}); err == nil {
			emit(kernel.AgentEvent{Type: kernel.EvCompact, SavedTokens: saved})
		} else if cut := TrimContext(app.Messages, app.Config.ContextLimit); cut > 0 {
			emit(kernel.AgentEvent{Type: kernel.EvTrimmed, Count: cut})
		}
	}

	emit(kernel.AgentEvent{Type: kernel.EvTurnStart, ID: newEventID()})
	emit(kernel.AgentEvent{Type: kernel.EvUser, Text: line})

	app.Messages = append(app.Messages, kernel.ChatMessage{Role: "user", Content: kernel.StrPtr(line)})
	mark := len(app.Messages) - 1
	appendSince := func() {
		for _, m := range app.Messages[mark:] {
			app.Store.Append(m)
		}
	}

	err := RunTurn(ctx, &app.Messages, TurnDeps{
		Provider: app.Provider,
		Tools:    app.Registry.Tools(),
		App:      app,
		Check:    hooks.Check,
		OnText: func(delta string) {
			emit(kernel.AgentEvent{Type: kernel.EvTextDelta, Delta: delta})
		},
		OnUsage: func(u kernel.Usage) {
			emit(kernel.AgentEvent{Type: kernel.EvUsage, PromptTokens: u.PromptTokens, CompletionTokens: u.CompletionTokens})
		},
		OnToolCall: func(callID, name string, args map[string]any) {
			emit(kernel.AgentEvent{Type: kernel.EvToolCall, CallID: callID, Name: name, Args: args})
		},
		OnToolResult: func(callID, name, result string, ms int64) {
			emit(kernel.AgentEvent{Type: kernel.EvToolResult, CallID: callID, Name: name,
				Summary: firstLine(result), Ms: int(ms)})
		},
	})
	if err != nil {
		// 中止与错误的区分：ctx 已取消 = 用户中止，其余按异常处理
		reason, errMsg := kernel.TurnAborted, ""
		if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
			reason, errMsg = kernel.TurnError, err.Error()
		}
		// 中断可能留下"有工具调用、无回应"的断尾，补占位保证消息序列对 API 合法
		app.Messages = fixDanglingToolCalls(app.Messages)
		appendSince()
		emit(kernel.AgentEvent{Type: kernel.EvTurnEnd, Reason: reason, Error: errMsg})
		return err
	}
	appendSince()
	emit(kernel.AgentEvent{Type: kernel.EvTurnEnd, Reason: kernel.TurnCompleted})
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

// firstLine 取文本首行（tool_result 摘要）。
func firstLine(s string) string {
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			return s[:i]
		}
	}
	return s
}

// newEventID 生成 uuid v4 形状的事件 id（crypto/rand，无第三方依赖）。
func newEventID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}
