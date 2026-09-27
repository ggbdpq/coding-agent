// 系统提示词：gcode 身份 + 运行环境 + 指令文件注入 + 技能索引。
// 注入顺序：~/.gcode/AGENTS.md（全局）在前，项目根 AGENTS.md 在后（后者更具体）。
// Skill 约定：~/.gcode/skills/*.md 与 <cwd>/.gcode/skills/*.md 为技能库，
// 此处只注入"可用技能索引"，正文由 agent 按需用 read 工具读取——最小机制，无加载器。
package core

import (
	"fmt"
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

// SkillIndex 技能索引：列出技能目录中每个 .md 的名字与首行说明；无任何条目返回空串。
func SkillIndex(dirs []string) string {
	var lines []string
	for _, rawDir := range dirs {
		dir, err := filepath.Abs(rawDir)
		if err != nil {
			continue
		}
		if _, err := os.Stat(dir); err != nil {
			continue // 目录不存在跳过
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			if os.IsNotExist(err) {
				continue // 目录刚好消失
			}
			// 权限等错误：stderr 警告后跳过——不静默（让用户看得见），也不打断启动
			// （SkillIndex 在 FreshMessages 闭包语境被调用，上抛会击穿提示词装配）
			fmt.Fprintf(os.Stderr, "skill 索引：跳过不可读目录 %s（%v）\n", dir, err)
			continue
		}
		for _, entry := range entries {
			name := entry.Name()
			if !strings.HasSuffix(name, ".md") {
				continue
			}
			full := filepath.Join(dir, name)
			// 边界自检（规范惯用法）：文件必须位于技能目录之内
			if !strings.HasPrefix(full, dir+string(filepath.Separator)) {
				continue
			}
			desc := ""
			if data, err := os.ReadFile(full); err == nil {
				desc = firstHeadingDesc(data)
			} // 读不了就只列名字
			lines = append(lines, fmt.Sprintf("- %s/%s：%s（用 read 工具按需读取全文）",
				filepath.Base(dir), name, desc))
		}
	}
	if len(lines) == 0 {
		return ""
	}
	return strings.Join(append([]string{"## 可用技能（按需用 read 读取全文）"}, lines...), "\n")
}

// firstHeadingDesc 取第一条非空行，去前导 # 与紧随空白，按 rune 截 60（中文不碎）。
func firstHeadingDesc(data []byte) string {
	var first string
	for _, l := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(l) != "" {
			first = l
			break
		}
	}
	desc := strings.TrimLeft(strings.TrimLeft(first, "#"), " \t")
	if runes := []rune(desc); len(runes) > 60 {
		return string(runes[:60])
	}
	return desc
}

// BuildSystemPrompt 拼装 system 提示词。
func BuildSystemPrompt(cwd string) string {
	today := time.Now().Format("2006-01-02")
	parts := []string{
		"你是 gcode，一个直接运行在用户本地终端的极简 coding agent。",
		"当前工作目录：" + cwd,
		"操作系统：" + runtime.GOOS + "；今天日期：" + today,
		"",
		"工作原则：",
		"- 动手改代码前先 read 相关文件，弄清上下文再动手。",
		"- 修改文件用 edit 做精确替换，old_string 必须带足够上下文保证唯一；新文件才用 write。",
		"- 跨文件多处一致的修改用 apply_patch 原子补丁（先全部预验再写入）。",
		"- 修改后用 bash 运行相关测试或命令验证，如实报告结果，绝不谎报通过。",
		"- 找不到文件时先用 glob/grep 定位，不要瞎猜路径。",
		"- 回答用简体中文，简洁直接。",
	}
	if global := readIfExists(filepath.Join(homeDir(), ".gcode", "AGENTS.md")); global != "" {
		parts = append(parts, "", "# 用户全局指令（~/.gcode/AGENTS.md）", global)
	}
	if project := readIfExists(filepath.Join(cwd, "AGENTS.md")); project != "" {
		parts = append(parts, "", "# 项目指令（AGENTS.md）", project)
	}
	var skillDirs []string
	if home := homeDir(); home != "" {
		skillDirs = append(skillDirs, filepath.Join(home, ".gcode", "skills"))
	}
	skillDirs = append(skillDirs, filepath.Join(cwd, ".gcode", "skills"))
	if skills := SkillIndex(skillDirs); skills != "" {
		parts = append(parts, "", skills)
	}
	return strings.Join(parts, "\n")
}
