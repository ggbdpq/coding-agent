// 入口：装配——注册内置插件 → 创建 App → 起 shell（repl）或无交互 exec。
// 缺配置给中文指路，不甩堆栈。
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gcode/internal/core"
	"gcode/internal/kernel"
	"gcode/internal/plugins"
)

const usage = `gcode —— 极简本地优先 coding agent

用法：gcode [exec "任务"] [--continue] [--yolo] [--help] [--version]

  exec "任务"  无交互执行单个任务后退出（CI/脚本用；必须配合 --yolo）
  --continue   启动时恢复最近一次会话
  --yolo       跳过写文件/执行命令的逐次确认（会话内可用 /yolo 切换）
  --help       显示本帮助
  --version    显示版本

环境变量：GCODE_API_KEY / GCODE_BASE_URL / GCODE_MODEL / GCODE_PROTOCOL / GCODE_APPROVAL
          （或写 ~/.gcode/config.json）`

func main() {
	args := os.Args[1:]
	for _, a := range args {
		switch a {
		case "--help", "-h":
			fmt.Println(usage)
			return
		case "--version":
			fmt.Printf("gcode v%s\n", kernel.Version)
			return
		}
	}

	var rest []string
	yolo, cont := false, false
	for _, a := range args {
		switch a {
		case "--yolo":
			yolo = true
		case "--continue":
			cont = true
		default:
			if !strings.HasPrefix(a, "--") {
				rest = append(rest, a)
			}
		}
	}
	// 位置参数首个 exec 切到无交互壳，其余为任务描述；repl 不吃位置参数
	shellName := "repl"
	if len(rest) > 0 && rest[0] == "exec" {
		shellName = "exec"
		rest = rest[1:]
	}
	if shellName == "repl" && len(rest) > 0 {
		fmt.Printf("提示：忽略多余参数：%s\n", strings.Join(rest, " "))
	}

	if err := run(shellName, rest, yolo, cont); err != nil {
		fmt.Fprintf(os.Stderr, "启动失败：%s\n", err)
		os.Exit(1)
	}
}

func run(shellName string, task []string, yolo, cont bool) error {
	config, err := kernel.LoadConfig()
	if err != nil {
		return err
	}
	store, err := core.NewSessionStore(filepath.Join(config.GocodeDir, "sessions"))
	if err != nil {
		return err
	}
	registry := kernel.NewRegistry().MustRegister(plugins.Builtin()...)
	app, err := kernel.CreateApp(config, registry, kernel.AppOptions{
		// 审批策略 never 与 --yolo 等价（R4）
		Yolo: yolo || config.Approval == "never",
		FreshMessages: func() []kernel.ChatMessage {
			cwd, err := os.Getwd()
			if err != nil {
				cwd = "."
			}
			return []kernel.ChatMessage{{Role: "system", Content: kernel.StrPtr(core.BuildSystemPrompt(cwd))}}
		},
		Store: store,
	})
	if err != nil {
		return err
	}

	if cont {
		resumeLatest(app)
	}

	if shellName == "exec" {
		runExec(app, task) // 出错自行以退出码 1 收尾
		return nil
	}
	shell := registry.Shell(shellName)
	if shell == nil {
		return fmt.Errorf("找不到 shell 插件：%s", shellName)
	}
	return shell.Start(app)
}

// resumeLatest --continue：加载最近会话的全部非 system 消息并入当前会话，
// 换新会话文件继续写（与 /resume <编号> 1 同语义）。
func resumeLatest(app *kernel.App) {
	latest := app.Store.ListRecent(1)
	if len(latest) == 0 {
		fmt.Println("没有可恢复的会话，从新会话开始。")
		return
	}
	var loaded []kernel.ChatMessage
	for _, m := range app.Store.Load(latest[0].File) {
		if m.Role != "system" {
			loaded = append(loaded, m)
		}
	}
	app.Messages = append(app.Messages, loaded...)
	app.StartSession(map[string]any{"resumedFrom": filepath.Base(latest[0].File)})
	fmt.Printf("已恢复最近会话（%d 条消息）。\n", len(loaded))
}

// runExec 无交互执行单个任务：事件渲染为纯文本行，任务完成后退出码 0、出错 1。
// exec 已强制 --yolo，无需交互闸门。
func runExec(app *kernel.App, rest []string) {
	if !app.Yolo.Value {
		fmt.Fprintln(os.Stderr, "错误：exec 模式必须配合 --yolo（无交互环境无法逐次确认写操作）")
		os.Exit(1)
	}
	task := core.ExpandAtRefs(strings.Join(rest, " "), core.ReadCapped)
	if strings.TrimSpace(task) == "" {
		fmt.Fprintln(os.Stderr, `错误：exec 需要任务描述：gcode exec "任务"`)
		os.Exit(1)
	}
	failed := false
	err := core.RunUserTurn(context.Background(), app, task, core.TurnHooks{
		Emit: func(ev kernel.AgentEvent) {
			switch ev.Type {
			case kernel.EvTextDelta:
				fmt.Print(ev.Delta)
			case kernel.EvToolCall:
				b, _ := json.Marshal(ev.Args)
				fmt.Printf("\n[tool] %s %s\n", ev.Name, kernel.Ellipsis(string(b), 160))
			case kernel.EvToolResult:
				fmt.Printf("[result] %s (%dms)\n", ev.Summary, ev.Ms)
			case kernel.EvTurnEnd:
				if ev.Reason != kernel.TurnCompleted {
					fmt.Fprintf(os.Stderr, "\n[turn:%s]%s\n", ev.Reason, ev.Error)
					failed = true
				}
			}
		},
	})
	fmt.Println()
	if err != nil {
		fmt.Fprintf(os.Stderr, "错误：%s\n", err)
		failed = true
	}
	if failed {
		os.Exit(1)
	}
}
