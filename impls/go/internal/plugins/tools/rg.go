// rg 工具函数：glob/grep 两个工具共用。约定退出码：0 有匹配、1 无匹配、≥2 出错。
package tools

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"unicode/utf8"
)

// runRg 执行 ripgrep 并按约定整理输出。
func runRg(ctx context.Context, rgArgs []string, maxRunes int) string {
	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}

	cmd := exec.CommandContext(ctx, "rg", rgArgs...) //nolint:gosec // 程序固定为 rg、无 shell，模型参数只作为 argv（grep 的 pattern 在 -- 之后）
	cmd.Dir = cwd

	var stdout limitedBuffer

	stdout.limit = maxRunes + 1000

	var stderr bytes.Buffer

	cmd.Stdout = &stdout

	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil && ctx.Err() == nil {
		return fmt.Sprintf("错误：无法启动 rg（%s）。本工具依赖 ripgrep，请先安装。", err)
	}

	waitErr := cmd.Wait()

	if ctx.Err() != nil {
		return fmt.Sprintf("错误：rg 已中止（%s）", ctx.Err())
	}

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
	if utf8.RuneCountInString(out) > maxRunes {
		runes := []rune(out)

		out = string(runes[:maxRunes]) + "\n…（结果超长已截断）"
	}

	out = strings.TrimRight(out, " \t\n\r")
	if out == "" {
		return "无匹配"
	}

	return out
}
