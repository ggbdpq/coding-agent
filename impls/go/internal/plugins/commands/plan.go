// /plan：切换 Plan Mode（只读规划）。开启时写类工具在 agentloop 被拒，
// 引导模型只读探索并产出计划；关闭后恢复正常执行。
// 系统提示词的 Plan Mode 分节由本命令直接维护在 Messages[0] 上。
package commands

import (
	"fmt"
	"strings"

	"gcode/internal/kernel"
)

// planSection 以空行起头追加到 system 提示词之后。
const planSection = "\n# Plan Mode（当前生效）\n" +
	"当前为只读规划阶段：禁止 write/edit/bash/web_fetch 等写类操作。\n" +
	"请用 read/glob/grep 只读探索，并用 todo 工具把分步计划记录下来；\n" +
	"计划完成后明确告知用户：切换回普通模式（/plan）执行。"

// PlanCmd 构造 /plan 命令插件。
func PlanCmd() *kernel.CommandDef {
	return &kernel.CommandDef{
		Name: "plan", Usage: "/plan", Summary: "切换 Plan Mode（只读规划 ↔ 普通执行）",
		Run: func(app *kernel.App, _ []string) kernel.CommandOutcome {
			app.PlanMode.Value = !app.PlanMode.Value
			if app.PlanMode.Value {
				sys := app.Messages[0]
				if sys.Content == nil || !strings.Contains(*sys.Content, "# Plan Mode") {
					base := ""
					if sys.Content != nil {
						base = *sys.Content
					}
					app.Messages[0].Content = kernel.StrPtr(base + planSection)
				}
				fmt.Println(kernel.Yellow("已进入 Plan Mode：只读探索与规划，写类工具将被拒绝。"))
			} else {
				if sys := app.Messages[0]; sys.Content != nil {
					app.Messages[0].Content = kernel.StrPtr(strings.Split(*sys.Content, "\n# Plan Mode（当前生效）")[0])
				}
				fmt.Println(kernel.Green("已退出 Plan Mode，恢复正常执行。"))
			}
			return kernel.CommandOutcome{}
		},
	}
}
