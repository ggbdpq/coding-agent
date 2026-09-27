// /sessions：列出最近会话（/resume 无编号的列表视图；加载仍用 /resume <编号>）。
package commands

import (
	"fmt"
	"time"

	"gcode/internal/kernel"
)

// SessionsCmd 构造 /sessions 命令插件。
func SessionsCmd() *kernel.CommandDef {
	return &kernel.CommandDef{
		Name:    "sessions",
		Usage:   "/sessions",
		Summary: "列出最近会话（用 /resume <编号> 加载）",
		Run: func(app *kernel.App, _ []string) kernel.CommandOutcome {
			list := app.Store.ListRecent(5)
			if len(list) == 0 {
				fmt.Println(kernel.Yellow("暂无历史会话。"))
				return kernel.CommandOutcome{}
			}
			fmt.Println("最近的会话：")
			for i, s := range list {
				fmt.Printf("  %d. %s %s\n", i+1,
					kernel.Dim(time.UnixMilli(s.Mtime).Format("2006-01-02 15:04:05")), s.Label)
			}
			return kernel.CommandOutcome{}
		},
	}
}
