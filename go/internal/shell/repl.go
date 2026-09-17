// REPL 壳：读入 → 命令查表分发 → runUserTurn → 打印。命令本体都是插件，壳只管路由。
// v1 取舍：轮中 Ctrl+C 直接退出进程（SIGINT 默认行为），不做轮中中止——见 README 已知局限。
package shell

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"gocode/internal/core"
	"gocode/internal/kernel"
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
		fmt.Sprintf("%s v%s %s", kernel.Bold("gocode"), kernel.Version,
			kernel.Dim(fmt.Sprintf("· %s · %s", app.Config.Model, currentDir()))),
	}
	if app.Yolo.Value {
		banner = append(banner, kernel.Yellow("当前 --yolo：所有操作免确认"))
	}
	banner = append(banner, kernel.Dim("输入 /help 查看命令，/exit 退出"))
	fmt.Println(strings.Join(banner, "\n"))

	for {
		fmt.Print(kernel.Cyan("gocode❯ "))
		line, err := reader.ReadString('\n')
		line = strings.TrimSpace(line)
		if line == "" {
			if err != nil {
				break // stdin 关闭
			}
			continue
		}

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

		turnErr := core.RunUserTurn(context.Background(), app, line, core.TurnHooks{
			Check: gate,
			OnText: func(t string) {
				fmt.Print(t)
			},
			OnToolCall: func(name string, args map[string]any) {
				b, _ := json.Marshal(args)
				fmt.Printf("\n%s %s\n", kernel.Cyan("⚙ "+name), kernel.Dim(kernel.Ellipsis(string(b), 120)))
			},
			OnToolResult: func(name, result string, ms int64) {
				first := result
				if i := strings.IndexByte(result, '\n'); i >= 0 {
					first = result[:i]
				}
				fmt.Println(kernel.Dim(fmt.Sprintf("  ↳ %s (%dms)", kernel.Ellipsis(first, 100), ms)))
			},
			OnTrimmed: func(count int) {
				fmt.Println(kernel.Dim(fmt.Sprintf("（上下文超预算，已省略 %d 条早期工具输出）", count)))
			},
		})
		if turnErr != nil {
			fmt.Println(kernel.Red("出错了：" + turnErr.Error()))
		} else {
			fmt.Println()
		}
	}
	return nil
}

func currentDir() string {
	cwd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return cwd
}
