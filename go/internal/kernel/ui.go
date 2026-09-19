// 终端着色与截断：零依赖 ANSI，仅在 TTY 上着色（重定向/冒烟测试输出保持干净）。
// 放 kernel：core 与 plugins 两层都要用，属共享工具。
package kernel

import (
	"fmt"
	"os"
	"strings"
	"unicode/utf8"
)

func isTTY(f *os.File) bool {
	fi, err := f.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}

func paint(code, s string) string {
	if !isTTY(os.Stdout) {
		return s
	}
	return "\x1b[" + code + "m" + s + "\x1b[0m"
}

// 语义色：Dim 次要信息、Cyan 提示符/工具名、Green 成功、Yellow 警示、Red 错误、Bold 强调。
func Dim(s string) string    { return paint("2", s) }
func Cyan(s string) string   { return paint("36", s) }
func Green(s string) string  { return paint("32", s) }
func Yellow(s string) string { return paint("33", s) }
func Red(s string) string    { return paint("31", s) }
func Bold(s string) string   { return paint("1", s) }

// Ellipsis 超长文本截断，末尾标注省略了多少字符。
func Ellipsis(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	runes := []rune(s)
	return fmt.Sprintf("%s\n…（已截断，省略 %d 字符）", string(runes[:max]), len(runes)-max)
}

// PreviewDiff 旧文本 → 新文本的简易行级 diff 预览（前缀 +/-，保留两侧公共首尾行减少噪音）。
// 不做 LCS 最小 diff——确认预览要的是"改了什么"而非"最短编辑脚本"；
// 需要精确 diff 时升级为独立渲染器。
func PreviewDiff(oldText, newText string, maxLines int) string {
	oldLines := strings.Split(oldText, "\n")
	newLines := strings.Split(newText, "\n")
	// 公共前缀/后缀
	pre := 0
	for pre < len(oldLines) && pre < len(newLines) && oldLines[pre] == newLines[pre] {
		pre++
	}
	suf := 0
	for suf < len(oldLines)-pre && suf < len(newLines)-pre &&
		oldLines[len(oldLines)-1-suf] == newLines[len(newLines)-1-suf] {
		suf++
	}
	var removed, added, ctxBefore, ctxAfter []string
	for _, l := range oldLines[pre : len(oldLines)-suf] {
		removed = append(removed, "-"+l)
	}
	for _, l := range newLines[pre : len(newLines)-suf] {
		added = append(added, "+"+l)
	}
	for _, l := range oldLines[max(0, pre-2):pre] {
		ctxBefore = append(ctxBefore, " "+l)
	}
	for _, l := range newLines[len(newLines)-suf : min(len(newLines)-suf+2, len(newLines))] {
		ctxAfter = append(ctxAfter, " "+l)
	}
	lines := append(append(append(ctxBefore, removed...), added...), ctxAfter...)
	body := strings.Join(lines[:min(maxLines, len(lines))], "\n")
	if len(lines) > maxLines {
		return fmt.Sprintf("%s\n…（diff 共 %d 行，已截断）", body, len(lines))
	}
	return body
}
