// 核心循环：一轮对话 = 往传入的 messages 推进，直到模型不再要工具。
// 不持有全局状态，方便测试与将来换壳（REPL/TUI/单发）。
// 注意：按分层规则 loop 不插件化（对齐 tcode Q4 决策）——它是这个项目的灵魂考点，
// 保持普通导出函数，接口化可替换但不进注册表。
package core

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"gocode/internal/kernel"
)

// MaxToolRounds 防失控：单轮对话最多允许的工具往返次数。
const MaxToolRounds = 40

// TurnDeps RunTurn 的依赖注入。
type TurnDeps struct {
	Provider kernel.ChatClient
	Tools    []*kernel.ToolDef
	// Check 权限闸门（needsPermission 的工具会被询问）；nil 视为全部放行
	Check func(toolName, preview string) bool
	// OnText 正文增量回调
	OnText func(delta string)
	// OnToolCall 工具开始执行前回调（REPL 用来打回显）
	OnToolCall func(name string, args map[string]any)
	// OnToolResult 工具执行完回调（含拒绝与耗时）
	OnToolResult func(name, result string, ms int64)
}

// RunTurn 推进 *messages 直到模型不再要工具；40 轮熔断后不带工具再请求一次总结。
// 工具错误一律以 "错误：..." 文本回流，不向上抛。
func RunTurn(ctx context.Context, messages *[]kernel.ChatMessage, deps TurnDeps) error {
	push := func(m kernel.ChatMessage) { *messages = append(*messages, m) }
	schemas := kernel.ToolSchemas(deps.Tools)

	for round := 0; round < MaxToolRounds; round++ {
		res, err := deps.Provider.Chat(ctx, *messages, kernel.ChatOptions{Tools: schemas, OnText: deps.OnText})
		if err != nil {
			return err
		}
		push(res.Message)
		if len(res.Message.ToolCalls) == 0 {
			return nil
		}

		for _, call := range res.Message.ToolCalls {
			args := map[string]any{}
			if parsed := parseArgs(call.Function.Arguments); parsed != nil {
				args = parsed
			}
			tool := findTool(deps.Tools, call.Function.Name)
			if tool == nil {
				push(kernel.ChatMessage{
					Role:       "tool",
					ToolCallID: call.ID,
					Content: kernel.StrPtr(fmt.Sprintf("错误：未知工具 %s。可用工具：%s",
						call.Function.Name, toolNames(deps.Tools))),
				})
				continue
			}
			if deps.OnToolCall != nil {
				deps.OnToolCall(tool.Name, args)
			}

			allowed := true
			if tool.NeedsPermission && deps.Check != nil {
				allowed = deps.Check(tool.Name, tool.Preview(args))
			}
			if !allowed {
				push(kernel.ChatMessage{
					Role:       "tool",
					ToolCallID: call.ID,
					Content:    kernel.StrPtr("用户拒绝了本次操作。请询问用户怎么办，或换一种方式；不要未经允许重试同样的操作。"),
				})
				if deps.OnToolResult != nil {
					deps.OnToolResult(tool.Name, "（用户已拒绝）", 0)
				}
				continue
			}

			start := time.Now()
			result := tool.Run(args)
			ms := time.Since(start).Milliseconds()
			push(kernel.ChatMessage{Role: "tool", ToolCallID: call.ID, Content: kernel.StrPtr(result)})
			if deps.OnToolResult != nil {
				deps.OnToolResult(tool.Name, result, ms)
			}
		}
	}

	// 轮次熔断：不带工具再要一次总结，防止无限打转
	res, err := deps.Provider.Chat(ctx, *messages, kernel.ChatOptions{OnText: deps.OnText})
	if err != nil {
		return err
	}
	push(res.Message)
	return nil
}

// parseArgs 工具参数 JSON → map；非法参数返回 nil（落下去让工具的"错误"文本纠正模型）。
func parseArgs(raw string) map[string]any {
	if raw == "" {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil || m == nil {
		return nil
	}
	return m
}

func findTool(tools []*kernel.ToolDef, name string) *kernel.ToolDef {
	for _, t := range tools {
		if t.Name == name {
			return t
		}
	}
	return nil
}

func toolNames(tools []*kernel.ToolDef) string {
	names := make([]string, 0, len(tools))
	for _, t := range tools {
		names = append(names, t.Name)
	}
	return strings.Join(names, ", ")
}
