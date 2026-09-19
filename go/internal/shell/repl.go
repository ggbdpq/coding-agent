// REPL 壳：读入 → 命令查表分发 → runUserTurn → 渲染事件。命令本体都是插件，壳只管路由。
// v0.3 取消语义：轮中 Ctrl+C = 取消本轮（HTTP 断、bash 杀、回到提示符，上下文保留），
// 再按 = 强制退出；空闲时 Ctrl+C = 退出进程。
package shell

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strings"

	"gcode/internal/core"
	"gcode/internal/kernel"
)

// Repl 返回 REPL 壳插件。
func Repl() *kernel.ShellDef {
	return &kernel.ShellDef{
		Name:  "repl",
		Start: startRepl,
	}
}

func startRepl(app *kernel.App) error {
	reader := bufio.NewReader(os.Stdin)

	// 权限 UI 适配：把"打印预览 + 问 y/n/a"接进统一闸门；stdin 关闭视作拒绝
	gate := core.NewPermissionGate(core.PermissionIOFunc(func(req core.PermissionRequest) core.PermissionDecision {
		fmt.Printf("\n%s\n%s\n", kernel.Yellow(fmt.Sprintf("── %s 请求执行 ──", req.Tool)), kernel.Dim(req.Preview))
		for {
			fmt.Print(kernel.Bold("允许? [y=允许 / n=拒绝 / a=本会话全部允许] "))
			line, err := reader.ReadString('\n')
			ans := strings.ToLower(strings.TrimSpace(line))
			switch ans {
			case "y":
				return core.DecisionAllow
			case "a":
				fmt.Println(kernel.Yellow("本会话后续操作不再逐次确认（可用 /yolo 切回）。"))
				return core.DecisionAlways
			case "n", "":
				return core.DecisionDeny
			}
			fmt.Println(kernel.Dim("请回答 y / n / a"))
			if err != nil {
				return core.DecisionDeny
			}
		}
	}), app.Yolo)

	// 横幅：版本/模型/cwd/yolo
	banner := []string{
		fmt.Sprintf("%s v%s %s", kernel.Bold("gcode"), kernel.Version,
			kernel.Dim(fmt.Sprintf("· %s · %s", app.Config.Model, currentDir()))),
	}
	if app.Yolo.Value {
		banner = append(banner, kernel.Yellow("当前 --yolo：所有操作免确认"))
	}
	banner = append(banner, kernel.Dim("输入 /help 查看命令，/exit 退出"))
	fmt.Println(strings.Join(banner, "\n"))

	for {
		fmt.Print(kernel.Cyan("gcode❯ "))
		line, err := reader.ReadString('\n')
		line = strings.TrimSpace(line)
		if line == "" {
			if err != nil {
				break // stdin 关闭
			}
			continue
		}

		// @文件引用：把 @path 展开为注入内容块（读取上限 1MB，再由 ExpandAtRefs 截断）
		line = core.ExpandAtRefs(line, core.ReadCapped)

		if strings.HasPrefix(line, "/") {
			fields := strings.Fields(line)
			name := strings.TrimPrefix(fields[0], "/")
			var cmd *kernel.CommandDef
			for _, c := range app.Registry.Commands() {
				if c.Name == name {
					cmd = c
					break
				}
			}
			if cmd == nil {
				fmt.Println(kernel.Yellow(fmt.Sprintf("未知命令 %s，/help 查看可用命令。", fields[0])))
				continue
			}
			outcome := cmd.Run(app, fields[1:])
			if outcome.Exit {
				break
			}
			continue
		}

		turnCtx, stopTurn := signal.NotifyContext(context.Background(), os.Interrupt)
		// 第一次 Ctrl+C 取消 turnCtx；NotifyContext 收到信号后自动注销，
		// 这里再挂一层监听器：第二次 Ctrl+C = 强制退出（先给提示）。
		turnDone := make(chan struct{})
		go func() {
			select {
			case <-turnCtx.Done():
				secondCtx, secondStop := signal.NotifyContext(context.Background(), os.Interrupt)
				defer secondStop()
				select {
				case <-secondCtx.Done():
					fmt.Println("\n（再次 Ctrl+C，强制退出）")
					os.Exit(130)
				case <-turnDone:
				}
			case <-turnDone:
			}
		}()

		turnErr := core.RunUserTurn(turnCtx, app, line, core.TurnHooks{
			Check: gate,
			Emit:  renderEvent,
		})
		close(turnDone)
		stopTurn()

		if turnErr != nil {
			// 展示方式是壳的事：中止与出错分开说
			if errors.Is(turnErr, context.Canceled) {
				fmt.Println(kernel.Yellow("\n（本轮已中止，上下文保留到上一个完整回答）"))
			} else {
				fmt.Println(kernel.Red("出错了：" + turnErr.Error()))
			}
		} else {
			fmt.Println()
		}
	}
	return nil
}

// renderEvent 终端渲染器：AgentEvent → 直接写终端（REPL 壳的展示层，无状态）。
func renderEvent(ev kernel.AgentEvent) {
	switch ev.Type {
	case kernel.EvTextDelta:
		fmt.Print(ev.Delta)
	case kernel.EvToolCall:
		b, _ := json.Marshal(ev.Args)
		fmt.Printf("\n%s %s\n", kernel.Cyan("⚙ "+ev.Name), kernel.Dim(kernel.Ellipsis(string(b), 120)))
	case kernel.EvToolResult:
		fmt.Println(kernel.Dim(fmt.Sprintf("  ↳ %s (%dms)", kernel.Ellipsis(ev.Summary, 100), ev.Ms)))
	case kernel.EvTrimmed:
		fmt.Println(kernel.Dim(fmt.Sprintf("（上下文超预算，已省略 %d 条早期工具输出）", ev.Count)))
	case kernel.EvCompact:
		fmt.Println(kernel.Dim(fmt.Sprintf("（上下文超预算，已压缩为任务摘要，节省约 %d tokens）", ev.SavedTokens)))
	default:
		// turn_start/user/turn_end 的展示由提示符、横幅与收尾逻辑承担
	}
}

func currentDir() string {
	cwd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return cwd
}
