// /init：在当前目录生成 AGENTS.md 起手模板（非 LLM 生成，确定性强；
// codex 式"让模型分析仓库生成"留作升级——需要事件流授权一个隐藏 turn）。
// 模板对应 systemprompt 的注入位：项目根 AGENTS.md 每次会话自动注入。
package commands

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gcode/internal/kernel"
)

var initTemplate = strings.Join([]string{
	"# AGENTS.md",
	"",
	"本文件是 gcode 在此项目工作的行为约束，每次会话自动注入。",
	"",
	"## 项目概要",
	"<用两三句话描述这个项目是做什么的>",
	"",
	"## 技术栈与命令",
	"- 构建：`<命令>`",
	"- 测试：`<命令>`",
	"- 格式化：`<命令>`",
	"",
	"## 工作约定",
	"- <例如：改代码前先跑相关测试>",
	"- <例如：提交信息用中文，遵循 conventional commits>",
	"- <例如：不要改 xxx 目录>",
}, "\n")

// InitCmd 构造 /init 命令插件。
func InitCmd() *kernel.CommandDef {
	return &kernel.CommandDef{
		Name:    "init",
		Usage:   "/init",
		Summary: "在当前目录生成 AGENTS.md 起手模板（已存在则不覆盖）",
		Run: func(app *kernel.App, _ []string) kernel.CommandOutcome {
			cwd, err := os.Getwd()
			if err != nil {
				cwd = "."
			}
			file := filepath.Join(cwd, "AGENTS.md")
			if _, err := os.Stat(file); err == nil {
				fmt.Println("AGENTS.md 已存在，未覆盖。可直接编辑它来调整项目约束。")
				return kernel.CommandOutcome{}
			}
			if err := os.WriteFile(file, []byte(initTemplate), 0o644); err != nil {
				fmt.Printf("生成失败：%s\n", err)
				return kernel.CommandOutcome{}
			}
			fmt.Printf("已生成 %s——编辑它补充项目概要、常用命令与工作约定，下次会话自动生效。\n", file)
			return kernel.CommandOutcome{}
		},
	}
}
