// 上下文预算：粗估 token（不引分词器依赖），超限时从最旧的工具输出裁起。
// 只动 tool 消息的 content，消息结构不动——assistant/tool_calls 与 tool 回应的
// 配对关系保持完整，后续请求对 API 依然合法。
package core

import (
	"unicode/utf8"

	"gocode/internal/kernel"
)

// keepRecentTools 保留最近多少条工具消息不动。
const keepRecentTools = 12

// TrimPlaceholder 裁剪占位文本（模型能看懂发生了什么）。
const TrimPlaceholder = "[早期工具输出已省略以释放上下文]"

func contentLen(s *string) int {
	if s == nil {
		return 0
	}
	return utf8.RuneCountInString(*s)
}

// EstimateTokens 粗估 token：按 3 字符 ≈ 1 token 折中（英文约 4 字符/词、中文更密），
// 另计每条消息与每个 tool_call 的固定开销。
func EstimateTokens(messages []kernel.ChatMessage) int {
	chars := 0
	for _, m := range messages {
		chars += contentLen(m.Content) + 8
		for _, tc := range m.ToolCalls {
			chars += utf8.RuneCountInString(tc.Function.Name) + utf8.RuneCountInString(tc.Function.Arguments) + 8
		}
	}
	return (chars + 2) / 3 // 向上取整
}

// TrimContext 就地裁剪，返回被裁的消息条数；保留最近 keepRecentTools 条工具输出，
// 裁完仍超限就到顶。占位消息不重复裁（幂等）。
func TrimContext(messages []kernel.ChatMessage, limit int) int {
	if EstimateTokens(messages) <= limit {
		return 0
	}
	var toolIdx []int
	for i, m := range messages {
		if m.Role == "tool" {
			toolIdx = append(toolIdx, i)
		}
	}
	if len(toolIdx) > keepRecentTools {
		toolIdx = toolIdx[:len(toolIdx)-keepRecentTools]
	} else {
		toolIdx = nil
	}
	trimmed := 0
	for _, i := range toolIdx {
		if EstimateTokens(messages) <= limit {
			break
		}
		m := &messages[i]
		if m.Content != nil && *m.Content != TrimPlaceholder {
			m.Content = kernel.StrPtr(TrimPlaceholder)
			trimmed++
		}
	}
	return trimmed
}
