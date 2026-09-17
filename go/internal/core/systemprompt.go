// 系统提示词：gocode 身份 + 运行环境 + 指令文件注入。
// 注入顺序：~/.gocode/AGENTS.md（全局）在前，项目根 AGENTS.md 在后（后者更具体）。
package core

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func readIfExists(file string) string {
	data, err := os.ReadFile(file)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func homeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

// BuildSystemPrompt 拼装 system 提示词。
func BuildSystemPrompt(cwd string) string {
	today := time.Now().Format("2006-01-02")
	parts := []string{
		"你是 gocode，一个直接运行在用户本地终端的极简 coding agent。",
		"当前工作目录：" + cwd,
		"操作系统：" + runtime.GOOS + "；今天日期：" + today,
		"",
		"工作原则：",
		"- 动手改代码前先 read 相关文件，弄清上下文再动手。",
		"- 修改文件用 edit 做精确替换，old_string 必须带足够上下文保证唯一；新文件才用 write。",
		"- 修改后用 bash 运行相关测试或命令验证，如实报告结果，绝不谎报通过。",
		"- 找不到文件时先用 glob/grep 定位，不要瞎猜路径。",
		"- 回答用简体中文，简洁直接。",
	}
	if global := readIfExists(filepath.Join(homeDir(), ".gocode", "AGENTS.md")); global != "" {
		parts = append(parts, "", "# 用户全局指令（~/.gocode/AGENTS.md）", global)
	}
	if project := readIfExists(filepath.Join(cwd, "AGENTS.md")); project != "" {
		parts = append(parts, "", "# 项目指令（AGENTS.md）", project)
	}
	return strings.Join(parts, "\n")
}
