// /exit：返回 exit 信号，由壳（repl）负责收尾退出。
package commands

import "gocode/internal/kernel"

// ExitCmd 构造 /exit 命令插件。
func ExitCmd() *kernel.CommandDef {
	return &kernel.CommandDef{
		Name: "exit", Usage: "/exit", Summary: "退出（Ctrl+C 亦可）",
		Run: func(*kernel.App, []string) kernel.CommandOutcome { return kernel.CommandOutcome{Exit: true} },
	}
}
