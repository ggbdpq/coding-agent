// 上下文压缩（R3，v0.4 打磨）：调当前模型把旧对话压成摘要，历史替换为
// [system, 摘要消息, 最近 TailKeep 条原文]。trim（裁旧丢历史）降级为 compact
// 失败时的兜底。纪律：摘要失败/中止时原 messages 原封不动——compact 永不破坏会话。
// 尾部切片点必须落在 user 消息上（配对安全：tool 不悬空、不打断 tool_call 配对）。
package core

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"gcode/internal/kernel"
)

// MinCompactMessages system + 至少 4 条对话才值得压缩。
const MinCompactMessages = 5

// TailKeep 摘要之外保留最近多少条原文（任务细节不丢）。
const TailKeep = 4

// summaryPrompt 摘要要求（对齐 tcode/core/compact.ts）。
const summaryPrompt = "请把下面的对话历史压缩成一份简洁的任务摘要，供后续工作参考。" +
	"必须保留：当前任务目标、已完成的关键步骤、重要文件路径与结论、尚未完成的事项。" +
	"直接输出摘要正文，不要客套。"

// pickTailStart 尾部起点必须落在 user 消息上：从 idealStart（含）起向后找最近的
// user 下标；找不到 user 边界则返回 len(messages)——不保留尾巴。
func pickTailStart(messages []kernel.ChatMessage, idealStart int) int {
	start := idealStart
	if start < 1 {
		start = 1
	}
	for i := start; i < len(messages); i++ {
		if messages[i].Role == "user" {
			return i
		}
	}
	return len(messages)
}

// CompactOpts 压缩的可选项：Ctx 取消贯穿摘要请求（HTTP 断连即中止）。
type CompactOpts struct {
	Ctx context.Context
}

// CompactContext 调当前模型把旧对话压成摘要并替换历史，返回压缩前后估算 token 之差。
// 失败/中止时原历史原封不动，返回非 nil 错误。
func CompactContext(app *kernel.App, opts CompactOpts) (savedTokens int, err error) {
	ctx := opts.Ctx
	if ctx == nil {
		ctx = context.Background()
	}
	if len(app.Messages) <= MinCompactMessages {
		return 0, errors.New("对话太短，没什么可压缩的")
	}
	before := EstimateTokens(app.Messages)

	var sb strings.Builder
	for _, m := range app.Messages[1:] {
		content := m.Text()
		if content == "" {
			content = fmt.Sprintf("(tool_calls: %d 个)", len(m.ToolCalls))
		}
		sb.WriteString(m.Role + ": " + content + "\n")
	}

	res, err := app.Provider.Chat(ctx, []kernel.ChatMessage{
		{Role: "system", Content: kernel.StrPtr("你是会话摘要器：只输出摘要正文，用简体中文，尽量精炼。")},
		{Role: "user", Content: kernel.StrPtr(summaryPrompt + "\n\n--- 对话历史 ---\n" + sb.String())},
	}, kernel.ChatOptions{})
	if err != nil {
		if ctx.Err() != nil {
			return 0, fmt.Errorf("已中止（用户取消）：%w", ctx.Err())
		}
		return 0, err
	}
	summary := res.Message.Text()
	if summary == "" {
		return 0, errors.New("模型返回了空摘要")
	}

	// 成功才动历史：system + 摘要 + 最近 TailKeep 条原文（切片点配对安全）
	tailStart := pickTailStart(app.Messages, len(app.Messages)-TailKeep)
	next := make([]kernel.ChatMessage, 0, 2+len(app.Messages)-tailStart)
	next = append(next, app.Messages[0], kernel.ChatMessage{
		Role:    "user",
		Content: kernel.StrPtr("[此前对话的摘要——当前任务以此为背景继续]\n" + summary + "\n[摘要结束]"),
	})
	next = append(next, app.Messages[tailStart:]...)
	app.Messages = next
	saved := before - EstimateTokens(app.Messages)
	if saved < 0 {
		saved = 0
	}
	return saved, nil
}
