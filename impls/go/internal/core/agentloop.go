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

	"gcode/internal/kernel"
)

// MaxToolRounds 防失控：单轮对话最多允许的工具往返次数。
const MaxToolRounds = 40

// TurnDeps RunTurn 的依赖注入。
type TurnDeps struct {
	Provider kernel.ChatClient
	Tools    []*kernel.ToolDef
	// App 白名单免确认（SkipPermission）所需的运行环境（config.allowWriteDirs）
	App *kernel.App
	// Check 权限闸门（needsPermission 的工具会被询问）；nil 视为全部放行
	Check func(toolName, preview string) bool
	// OnText 正文增量回调
	OnText func(delta string)
	// OnUsage token 用量回调（provider 每次补全触发；turn 层转成 usage 事件）
	OnUsage func(usage kernel.Usage)
	// OnToolCall 工具开始执行前回调（带模型的调用 id，事件流的 tool_call 源头）
	OnToolCall func(callID, name string, args map[string]any)
	// OnToolResult 工具执行完回调（含拒绝与耗时）
	OnToolResult func(callID, name, result string, ms int64)
}

// RunTurn 推进 *messages 直到模型不再要工具；40 轮熔断后不带工具再请求一次总结。
// 工具错误一律以 "错误：..." 文本回流，不向上抛。
func RunTurn(ctx context.Context, messages *[]kernel.ChatMessage, deps TurnDeps) error {
	push := func(m kernel.ChatMessage) { *messages = append(*messages, m) }
	schemas := kernel.ToolSchemas(deps.Tools)

	for round := 0; round < MaxToolRounds; round++ {
		res, err := deps.Provider.Chat(ctx, *messages, kernel.ChatOptions{Tools: schemas, OnText: deps.OnText, OnUsage: deps.OnUsage})
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
			// Plan Mode（只读规划）：写类工具拒绝执行，引导模型产出计划；
			// 判定在白名单与权限询问之前——不执行、不触发确认、不发 tool_call 事件
			if deps.App != nil && deps.App.PlanMode != nil && deps.App.PlanMode.Value && tool.NeedsPermission {
				denyText := "当前处于 Plan Mode（只读规划）：禁止执行写类操作。请继续只读探索，并输出一份分步计划；完成后告知用户用 /plan 切回普通模式执行。"
				push(kernel.ChatMessage{Role: "tool", ToolCallID: call.ID, Content: kernel.StrPtr(denyText)})
				if deps.OnToolResult != nil {
					deps.OnToolResult(call.ID, tool.Name, denyText, 0)
				}
				continue
			}
			if deps.OnToolCall != nil {
				deps.OnToolCall(call.ID, tool.Name, args)
			}

			// 白名单优先（SkipPermission 声明受信）→ 闸门逐次确认
			allowed := true
			if tool.NeedsPermission && deps.Check != nil {
				trusted := tool.SkipPermission != nil && tool.SkipPermission(args, deps.App)
				if !trusted {
					allowed = deps.Check(tool.Name, tool.Preview(args))
				}
			}
			if !allowed {
				push(kernel.ChatMessage{
					Role:       "tool",
					ToolCallID: call.ID,
					Content:    kernel.StrPtr("用户拒绝了本次操作。请询问用户怎么办，或换一种方式；不要未经允许重试同样的操作。"),
				})
				if deps.OnToolResult != nil {
					deps.OnToolResult(call.ID, tool.Name, "（用户已拒绝）", 0)
				}
				continue
			}

			start := time.Now()
			result := tool.Run(ctx, args)
			ms := time.Since(start).Milliseconds()
			push(kernel.ChatMessage{Role: "tool", ToolCallID: call.ID, Content: kernel.StrPtr(result)})
			if deps.OnToolResult != nil {
				deps.OnToolResult(call.ID, tool.Name, result, ms)
			}
		}
	}

	// 轮次熔断：不带工具再要一次总结，防止无限打转
	res, err := deps.Provider.Chat(ctx, *messages, kernel.ChatOptions{OnText: deps.OnText, OnUsage: deps.OnUsage})
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
