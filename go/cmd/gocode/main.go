// 入口：装配——注册内置插件 → 创建 App → 起 shell。缺配置给中文指路，不甩堆栈。
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gocode/internal/core"
	"gocode/internal/kernel"
	"gocode/internal/plugins"
)

const usage = `gocode —— 极简本地优先 coding agent

用法：gocode [--yolo] [--help] [--version]

  --yolo     跳过写文件/执行命令的逐次确认（会话内可用 /yolo 切换）
  --help     显示本帮助
  --version  显示版本

环境变量：GOCODE_API_KEY / GOCODE_BASE_URL / GOCODE_MODEL / GOCODE_PROTOCOL（或写 ~/.gocode/config.json）`

func main() {
	args := os.Args[1:]
	for _, a := range args {
		switch a {
		case "--help", "-h":
			fmt.Println(usage)
			return
		case "--version":
			fmt.Printf("gocode v%s\n", kernel.Version)
			return
		}
	}

	yolo := false
	var extra []string
	for _, a := range args {
		if a == "--yolo" {
			yolo = true
			continue
		}
		if !strings.HasPrefix(a, "--") {
			extra = append(extra, a)
		}
	}
	if len(extra) > 0 {
		fmt.Printf("提示：gocode 目前只支持交互式使用，忽略多余参数：%s\n", strings.Join(extra, " "))
	}

	if err := run(yolo); err != nil {
		fmt.Fprintf(os.Stderr, "启动失败：%s\n", err)
		os.Exit(1)
	}
}

func run(yolo bool) error {
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
		Yolo: yolo,
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
	shell := registry.Shell("repl")
	if shell == nil {
		return fmt.Errorf("找不到 shell 插件：repl")
	}
	return shell.Start(app)
}
