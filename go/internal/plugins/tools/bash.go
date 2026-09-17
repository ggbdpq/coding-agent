// bash 工具：子进程执行命令，输出封顶、超时强杀。
// win32 优先用 Git Bash（模型常发 unix 命令），只认显式路径，避免误中 System32 的 WSL bash；
// 都没有就退回 cmd。安全边界：执行前经权限确认，确认界面展示完整命令。
package tools

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"gocode/internal/kernel"
)

const (
	bashMaxOutput  = 64 * 1024
	bashDefaultSec = 120
	bashMaxSec     = 600
)

// shellCmd 解析出的 shell 及其固定参数。
type shellCmd struct {
	file string
	args []string
}

// resolveShell win32 优先 GOCODE_BASH → Git Bash 默认路径 → cmd。
func resolveShell() shellCmd {
	if runtime.GOOS == "windows" {
		var candidates []string
		if v := os.Getenv("GOCODE_BASH"); v != "" {
			candidates = append(candidates, v)
		}
		candidates = append(candidates, `C:\Program Files\Git\bin\bash.exe`)
		for _, b := range candidates {
			if _, err := os.Stat(b); err == nil {
				return shellCmd{file: b, args: []string{"-c"}}
			}
		}
		comspec := os.Getenv("COMSPEC")
		if comspec == "" {
			comspec = "cmd.exe"
		}
		return shellCmd{file: comspec, args: []string{"/d", "/s", "/c"}}
	}
	return shellCmd{file: "/bin/bash", args: []string{"-c"}}
}

// limitedBuffer 封顶缓冲：超过 limit 的字节继续吞掉（防子进程写阻塞），不再累积。
type limitedBuffer struct {
	buf   bytes.Buffer
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.buf.Len() < b.limit {
		room := b.limit - b.buf.Len()
		if len(p) > room {
			b.buf.Write(p[:room])
			return len(p), nil
		}
		b.buf.Write(p)
	}
	return len(p), nil
}

// NewBash 构造 bash 工具插件。
func NewBash() *kernel.ToolDef {
	return &kernel.ToolDef{
		Name:        "bash",
		Description: "在当前目录执行 shell 命令并返回退出码与输出。用于跑测试、构建、git 等验证操作；输出超长会被截断。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"command":     map[string]any{"type": "string", "description": "要执行的命令"},
				"timeout_sec": map[string]any{"type": "number", "description": fmt.Sprintf("超时秒数，默认 %d，上限 %d", bashDefaultSec, bashMaxSec)},
			},
			"required": []string{"command"},
		},
		NeedsPermission: true,
		Preview: func(args map[string]any) string {
			cwd, err := os.Getwd()
			if err != nil {
				cwd = "."
			}
			return fmt.Sprintf("执行命令（cwd=%s）\n$ %s", cwd, argString(args, "command"))
		},
		Run: func(args map[string]any) string { return runBash(args) },
	}
}

func runBash(args map[string]any) string {
	command := argString(args, "command")
	if strings.TrimSpace(command) == "" {
		return "错误：缺少 command"
	}
	timeoutSec := int(math.Max(1, math.Min(argNumber(args, "timeout_sec", bashDefaultSec), bashMaxSec)))
	shell := resolveShell()

	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}
	cmd := exec.Command(shell.file, append(shell.args, command)...)
	cmd.Dir = cwd
	var stdout, stderr limitedBuffer
	stdout.limit = bashMaxOutput
	stderr.limit = bashMaxOutput
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return fmt.Sprintf("错误：无法启动 shell（%s）", err)
	}

	var killed atomic.Bool
	timer := time.AfterFunc(time.Duration(timeoutSec)*time.Second, func() {
		killed.Store(true)
		if runtime.GOOS == "windows" && cmd.Process != nil {
			// Windows 上 kill 杀不掉子进程树，用 taskkill 连坐
			_ = exec.Command("taskkill", "/pid", strconv.Itoa(cmd.Process.Pid), "/T", "/F").Start()
		} else if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	})
	defer timer.Stop()

	waitErr := cmd.Wait()
	exitCode := 0
	if waitErr != nil {
		var ee *exec.ExitError
		if errors.As(waitErr, &ee) {
			exitCode = ee.ExitCode()
		} else {
			return fmt.Sprintf("错误：%s", waitErr)
		}
	}

	exitStr := fmt.Sprintf("exit=%d", exitCode)
	if killed.Load() {
		exitStr = fmt.Sprintf("exit=timeout（%ds 超时强制终止）", timeoutSec)
	} else if exitCode < 0 {
		exitStr = fmt.Sprintf("exit=signal:%d", -exitCode)
	}
	parts := []string{exitStr}
	if strings.TrimSpace(stdout.buf.String()) != "" {
		parts = append(parts, "--- stdout ---\n"+strings.TrimRight(capOutput(stdout.buf.String()), " \t\n\r"))
	}
	if strings.TrimSpace(stderr.buf.String()) != "" {
		parts = append(parts, "--- stderr ---\n"+strings.TrimRight(capOutput(stderr.buf.String()), " \t\n\r"))
	}
	return strings.Join(parts, "\n")
}

// capOutput 输出超长时截断并标注。
func capOutput(s string) string {
	if utf8.RuneCountInString(s) < bashMaxOutput {
		return s
	}
	runes := []rune(s)
	cut := string(runes[:bashMaxOutput])
	for !utf8.ValidString(cut) {
		cut = cut[:len(cut)-1]
	}
	return cut + "\n…（输出超长已截断）"
}
