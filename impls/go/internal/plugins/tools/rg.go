// rg 工具函数：glob/grep 两个工具共用。约定退出码：0 有匹配、1 无匹配、≥2 出错。
package tools

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"unicode/utf8"
)

// runRg 执行 ripgrep 并按约定整理输出。
func runRg(rgArgs []string, cap int) string {
	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}
	cmd := exec.Command("rg", rgArgs...)
	cmd.Dir = cwd
	var stdout limitedBuffer
	stdout.limit = cap + 1000
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return fmt.Sprintf("错误：无法启动 rg（%s）。本工具依赖 ripgrep，请先安装。", err)
	}
	waitErr := cmd.Wait()
	code := 0
	if waitErr != nil {
		var ee *exec.ExitError
		if errors.As(waitErr, &ee) {
			code = ee.ExitCode()
		} else {
			code = 2
		}
	}
	if code == 1 && strings.TrimSpace(stderr.String()) == "" {
		return "无匹配"
	}
	if code > 1 {
		errText := stderr.String()
		if utf8.RuneCountInString(errText) > 500 {
			errText = string([]rune(errText)[:500])
		}
		return fmt.Sprintf("错误：rg 退出码 %d：%s", code, strings.TrimSpace(errText))
	}
	out := stdout.buf.String()
	if utf8.RuneCountInString(out) > cap {
		runes := []rune(out)
		cut := string(runes[:cap])
		for !utf8.ValidString(cut) {
			cut = cut[:len(cut)-1]
		}
		out = cut + "\n…（结果超长已截断）"
	}
	out = strings.TrimRight(out, " \t\n\r")
	if out == "" {
		return "无匹配"
	}
	return out
}
