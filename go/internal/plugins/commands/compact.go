// /compact：手动触发上下文摘要压缩（自动触发见 core/turn.go 的超限治理）。
// 错误只打印不上抛：压缩失败永不破坏当前会话。
package commands

import (
	"context"
	"fmt"

	"gcode/internal/core"
	"gcode/internal/kernel"
)

// CompactCmd 构造 /compact 命令插件。
func CompactCmd() *kernel.CommandDef {
	return &kernel.CommandDef{
		Name: "compact", Usage: "/compact", Summary: "把当前对话压缩成摘要，释放上下文预算",
		Run: func(app *kernel.App, _ []string) kernel.CommandOutcome {
			saved, err := core.CompactContext(app, core.CompactOpts{Ctx: context.Background()})
			if err != nil {
				fmt.Printf("压缩未执行：%s\n", err)
				return kernel.CommandOutcome{}
			}
			fmt.Printf("已压缩：替换为任务摘要，节省约 %d tokens 的上下文预算。\n", saved)
			return kernel.CommandOutcome{}
		},
	}
}
