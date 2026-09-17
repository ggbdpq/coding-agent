// /yolo：切换本会话免确认模式（与 --yolo 启动参数、权限确认里的 a 改的是同一个开关）。
package commands

import (
	"fmt"

	"gocode/internal/kernel"
)

// YoloCmd 构造 /yolo 命令插件。
func YoloCmd() *kernel.CommandDef {
	return &kernel.CommandDef{
		Name: "yolo", Usage: "/yolo", Summary: "切换本会话免确认模式",
		Run: func(app *kernel.App, _ []string) kernel.CommandOutcome {
			app.Yolo.Value = !app.Yolo.Value
			if app.Yolo.Value {
				fmt.Println(kernel.Yellow("已开启免确认（yolo）。"))
			} else {
				fmt.Println(kernel.Green("已恢复逐次确认。"))
			}
			return kernel.CommandOutcome{}
		},
	}
}
