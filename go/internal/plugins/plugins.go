// 内置插件清单：加插件 = 加文件 + 在这里挂一行。
// 显式组合而非目录扫描——装配顺序可读、可预测。
// 注意 openai provider 必须排在 provider 类的最后（Matches 恒真，是兜底）。
package plugins

import (
	"gcode/internal/kernel"
	"gcode/internal/plugins/commands"
	"gcode/internal/plugins/tools"
	"gcode/internal/providers"
	"gcode/internal/shell"
)

// Builtin 返回全部内置插件（顺序即装配优先级）。
func Builtin() []kernel.Plugin {
	return []kernel.Plugin{
		// —— 工具 ——
		{Tool: tools.NewRead()},
		{Tool: tools.NewWrite()},
		{Tool: tools.NewEdit()},
		{Tool: tools.NewBash()},
		{Tool: tools.NewGlob()},
		{Tool: tools.NewGrep()},
		{Tool: tools.NewTodo()},
		{Tool: tools.NewWebFetch()},
		{Tool: tools.NewApplyPatch()},
		// —— 命令（/help 列表按这里的顺序展示） ——
		{Command: commands.HelpCmd()},
		{Command: commands.NewCmd()},
		{Command: commands.ResumeCmd()},
		{Command: commands.SessionsCmd()},
		{Command: commands.YoloCmd()},
		{Command: commands.PlanCmd()},
		{Command: commands.ApprovalCmd()},
		{Command: commands.CompactCmd()},
		{Command: commands.InitCmd()},
		{Command: commands.ExitCmd()},
		// —— 协议（anthropic 在前按 URL 命中，openai 恒真兜底必须在后） ——
		{Provider: providers.AnthropicPlugin},
		{Provider: providers.OpenAIPlugin},
		// —— 壳 ——
		{Shell: shell.Repl()},
	}
}
