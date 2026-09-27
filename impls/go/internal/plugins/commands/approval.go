// /approval：查看或切换审批策略（R4）。normal=写类逐次确认；never=全部免确认。
// 运行时改的就是同一份 Config，并把 yolo 开关同步到同义状态（never≡开、normal≡关）。
package commands

import (
	"fmt"
	"strings"

	"gcode/internal/kernel"
)

// ApprovalCmd 构造 /approval 命令插件。
func ApprovalCmd() *kernel.CommandDef {
	return &kernel.CommandDef{
		Name:    "approval",
		Usage:   "/approval [normal|never]",
		Summary: "查看或设置审批策略（normal=写类逐次确认，never=全部免确认）",
		Run: func(app *kernel.App, args []string) kernel.CommandOutcome {
			arg := strings.TrimSpace(strings.Join(args, " "))
			if arg == "" {
				hint := "（写类操作逐次确认）"
				if app.Config.Approval == "never" {
					hint = "（全部免确认，等价 --yolo）"
				}
				fmt.Printf("当前审批策略：%s%s\n", app.Config.Approval, hint)
				return kernel.CommandOutcome{}
			}
			if arg != "normal" && arg != "never" {
				fmt.Println(kernel.Yellow("审批策略只能是 normal 或 never，未修改。"))
				return kernel.CommandOutcome{}
			}
			app.Config.Approval = arg
			app.Yolo.Value = arg == "never"
			fmt.Printf("审批策略已设为 %s。\n", arg)
			return kernel.CommandOutcome{}
		},
	}
}
