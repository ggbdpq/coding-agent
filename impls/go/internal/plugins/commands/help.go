// /help：从注册表生成命令列表——新命令插件自动出现在帮助里。
package commands

import (
	"fmt"
	"strings"

	"gcode/internal/kernel"
)

// HelpText 生成帮助文本（独立导出便于复用与测试）。
func HelpText(app *kernel.App) string {
	rows := make([]string, 0, 8)
	for _, cmd := range app.Registry.Commands() {
		rows = append(rows, fmt.Sprintf("  %-15s%s", cmd.Usage, cmd.Summary))
	}
	return strings.Join(append([]string{"命令："},
		append(rows,
			"其他输入直接作为对话发给模型。",
			"Ctrl+C：轮中取消本轮（再次按下强制退出）；空闲时退出进程。",
		)...), "\n")
}

// HelpCmd 构造 /help 命令插件。
func HelpCmd() *kernel.CommandDef {
	return &kernel.CommandDef{
		Name: "help", Usage: "/help", Summary: "显示本帮助",
		Run: func(app *kernel.App, _ []string) kernel.CommandOutcome {
			fmt.Println(HelpText(app))
			return kernel.CommandOutcome{}
		},
	}
}
