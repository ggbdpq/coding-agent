// 终端着色与截断：零依赖 ANSI，仅在 TTY 上着色（重定向/冒烟测试输出保持干净）。
// 放 kernel：core 与 plugins 两层都要用，属共享工具。
package kernel

import (
	"fmt"
	"os"
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
