// /resume：恢复历史会话。无编号=列最近 5 个；编号=加载并换新会话文件继续写。
package commands

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"gocode/internal/kernel"
)

// ResumeCmd 构造 /resume 命令插件。
func ResumeCmd() *kernel.CommandDef {
	return &kernel.CommandDef{
		Name: "resume", Usage: "/resume [编号]", Summary: "恢复历史会话（无编号=列最近 5 个）",
		Run: func(app *kernel.App, args []string) kernel.CommandOutcome {
			list := app.Store.ListRecent(5)
			if len(list) == 0 {
				fmt.Println(kernel.Yellow("暂无可恢复的历史会话。"))
				return kernel.CommandOutcome{}
			}
			n, err := strconv.Atoi(strings.TrimSpace(strings.Join(args, " ")))
			if err != nil || n < 1 || n > len(list) {
				fmt.Println("最近的会话：")
				for i, s := range list {
					fmt.Printf("  %d. %s %s\n", i+1,
						kernel.Dim(time.UnixMilli(s.Mtime).Format("2006-01-02 15:04:05")), s.Label)
				}
				if err != nil {
					fmt.Println(kernel.Yellow("用 /resume <编号> 加载"))
				} else {
					fmt.Println(kernel.Yellow(fmt.Sprintf("编号无效（1-%d）", len(list))))
				}
				return kernel.CommandOutcome{}
			}
			picked := list[n-1]
			loaded := app.Store.Load(picked.File)
			var filtered []kernel.ChatMessage
			for _, m := range loaded {
				if m.Role != "system" {
					filtered = append(filtered, m)
				}
			}
			app.ResetMessages()
			app.Messages = append(app.Messages, filtered...)
			app.StartSession(map[string]any{"resumedFrom": filepath.Base(picked.File)})
			fmt.Println(kernel.Green(fmt.Sprintf("已恢复 %d 条消息，后续写入新会话文件。", len(filtered))))
			return kernel.CommandOutcome{}
		},
	}
}
