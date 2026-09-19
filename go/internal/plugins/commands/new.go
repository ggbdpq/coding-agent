// /new：开新会话——messages 换新 system 数组并换新会话文件。
package commands

import (
	"fmt"

	"gcode/internal/kernel"
)

// NewCmd 构造 /new 命令插件。
func NewCmd() *kernel.CommandDef {
	return &kernel.CommandDef{
		Name: "new", Usage: "/new", Summary: "开新会话（清空上下文）",
		Run: func(app *kernel.App, _ []string) kernel.CommandOutcome {
			app.ResetMessages()
			app.StartSession(nil)
			fmt.Println(kernel.Green("已开新会话，上下文已清空。"))
			return kernel.CommandOutcome{}
		},
	}
}
