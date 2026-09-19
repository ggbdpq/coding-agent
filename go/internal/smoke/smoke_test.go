// 端到端冒烟（无网络）：先 go build 出真二进制，再以子进程跑 REPL，
// 本地假 SSE 服务器按剧本回包（对齐 tcode/test/smoke.mjs 的 A/B/C/D 区段，
// F 场景为 REPL 版权限确认：stdin 喂 y/n 断言 allow/deny 两轮）。
package smoke

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

var (
	exePath   string
	serverURL string // http://127.0.0.1:<port>/v1

	bodiesMu sync.Mutex
	bodies   []string // 假服务器收到的每个请求体
)

func TestMain(m *testing.M) {
	// 1. 假 SSE 服务器
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintf(os.Stderr, "冒烟：起服务器失败：%v\n", err)
		os.Exit(1)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	server := &http.Server{Handler: http.HandlerFunc(handleFakeSSE)}
	go server.Serve(ln) //nolint:errcheck // 测试进程退出时统一回收
	serverURL = fmt.Sprintf("http://127.0.0.1:%d/v1", port)

	// 2. 编译被测二进制（比 go run 子进程更稳：不经 go 工具链转发信号）
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		fmt.Fprintln(os.Stderr, "冒烟：定位源码路径失败")
		os.Exit(1)
	}
	root := filepath.Dir(filepath.Dir(filepath.Dir(thisFile))) // internal/smoke → 模块根
	buildDir, err := os.MkdirTemp("", "gcode-smoke-build-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "冒烟：建临时目录失败：%v\n", err)
		os.Exit(1)
	}
	exePath = filepath.Join(buildDir, "gcode-smoke.exe")
	build := exec.Command("go", "build", "-o", exePath, filepath.Join(root, "cmd", "gcode"))
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "冒烟：编译 gcode 失败：%v\n", err)
		os.Exit(1)
	}

	code := m.Run()
	server.Close()
	os.RemoveAll(buildDir)
	os.Exit(code)
}

// handleFakeSSE 按"最后一条消息角色 + 最新用户文本"分场（同 tcode 冒烟剧本）。
func handleFakeSSE(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	bodiesMu.Lock()
	bodies = append(bodies, string(raw))
	bodiesMu.Unlock()

	w.Header().Set("content-type", "text/event-stream")
	flusher := w.(http.Flusher)
	send := func(obj any) {
		b, _ := json.Marshal(obj)
		fmt.Fprintf(w, "data: %s\n\n", b)
		flusher.Flush()
	}
	finish := func() {
		fmt.Fprint(w, "data: [DONE]\n\n")
		flusher.Flush()
	}

	// ---------- Anthropic 协议分支（/v1/messages） ----------
	if strings.HasSuffix(r.URL.Path, "/v1/messages") {
		if strings.Contains(string(raw), "tool_result") {
			// 工具结果已回流：给最终回答
			send(map[string]any{"type": "message_start", "message": map[string]any{"role": "assistant"}})
			send(map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text"}})
			send(map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": "验证完成：smoke-anthropic"}})
			send(map[string]any{"type": "content_block_stop", "index": 0})
			send(map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "end_turn"}})
			send(map[string]any{"type": "message_stop"})
		} else {
			// 第一轮：正文 + 分两片的 tool_use input（考验碎片拼装）
			send(map[string]any{"type": "message_start", "message": map[string]any{"role": "assistant"}})
			send(map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text"}})
			send(map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": "我先跑个命令确认环境。"}})
			send(map[string]any{"type": "content_block_stop", "index": 0})
			send(map[string]any{"type": "content_block_start", "index": 1, "content_block": map[string]any{"type": "tool_use", "id": "toolu_smoke", "name": "bash"}})
			send(map[string]any{"type": "content_block_delta", "index": 1, "delta": map[string]any{"type": "input_json_delta", "partial_json": `{"command":`}})
			send(map[string]any{"type": "content_block_delta", "index": 1, "delta": map[string]any{"type": "input_json_delta", "partial_json": `"echo smoke-anthropic"}`}})
			send(map[string]any{"type": "content_block_stop", "index": 1})
			send(map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "tool_use"}})
			send(map[string]any{"type": "message_stop"})
		}
		return
	}

	// ---------- OpenAI 协议分支（/v1/chat/completions） ----------
	var lastRole, lastText string
	var parsed struct {
		Messages []struct {
			Role    string  `json:"role"`
			Content *string `json:"content"`
		} `json:"messages"`
	}
	if json.Unmarshal(raw, &parsed) == nil && len(parsed.Messages) > 0 {
		last := parsed.Messages[len(parsed.Messages)-1]
		lastRole = last.Role
		if last.Content != nil {
			lastText = *last.Content
		}
	}

	text := func(content, finishReason string) {
		send(map[string]any{"choices": []map[string]any{{"delta": map[string]any{"content": content}}}})
		send(map[string]any{"choices": []map[string]any{{"delta": map[string]any{}, "finish_reason": finishReason}}, "usage": map[string]any{"prompt_tokens": 20, "completion_tokens": 3}})
		finish()
	}

	if lastRole == "tool" {
		// 工具结果已回流（含被拦截的 web_fetch）：给最终回答
		text("验证完成：smoke-ok", "stop")
	} else if strings.Contains(lastText, "压缩成一份简洁的任务摘要") {
		// 场景G：/compact 的摘要请求——回一份含关键事实的假摘要
		text("这是摘要：任务是验证冒烟；暗号 smoke-secret；未完成事项：无", "stop")
	} else if strings.Contains(lastText, "对话") {
		// 场景G：三轮闲聊（喂够可压缩的消息条数）
		text("好的，已记下。", "stop")
	} else if strings.Contains(lastText, "暗号") {
		// 场景G：压缩后凭摘要答暗号
		text("暗号是 smoke-secret", "stop")
	} else if strings.Contains(lastText, "继续") {
		// 场景B：恢复历史后的追问
		text("好的，继续。", "stop")
	} else if strings.Contains(lastText, "试试抓取") {
		// 场景D：诱导抓取内网地址，验证 SSRF 拦截
		send(map[string]any{"choices": []map[string]any{{"delta": map[string]any{"role": "assistant", "content": "我来抓取这个地址试试。"}}}})
		send(map[string]any{"choices": []map[string]any{{"delta": map[string]any{
			"tool_calls": []map[string]any{{
				"index": 0, "id": "call_fetch", "type": "function",
				"function": map[string]any{"name": "web_fetch", "arguments": `{"url":"http://127.0.0.1:9/private"}`},
			}},
		}}}})
		send(map[string]any{"choices": []map[string]any{{"delta": map[string]any{}, "finish_reason": "tool_calls"}}, "usage": map[string]any{"prompt_tokens": 10, "completion_tokens": 5}})
		finish()
	} else {
		// 场景A第一轮：流式正文 + 一个 bash 工具调用
		send(map[string]any{"choices": []map[string]any{{"delta": map[string]any{"role": "assistant", "content": "我先跑个命令确认环境。"}}}})
		send(map[string]any{"choices": []map[string]any{{"delta": map[string]any{
			"tool_calls": []map[string]any{{
				"index": 0, "id": "call_smoke", "type": "function",
				"function": map[string]any{"name": "bash", "arguments": `{"command":"echo smoke-ok"}`},
			}},
		}}}})
		send(map[string]any{"choices": []map[string]any{{"delta": map[string]any{}, "finish_reason": "tool_calls"}}, "usage": map[string]any{"prompt_tokens": 10, "completion_tokens": 5}})
		finish()
	}
}

// ---------- 子进程封装 ----------

type proc struct {
	t     *testing.T
	cmd   *exec.Cmd
	stdin io.WriteCloser

	mu  sync.Mutex
	out strings.Builder
}

// startGocode 启动 gcode 子进程；HOME/USERPROFILE 与 GCODE_* 全部隔离到临时目录。
func startGocode(t *testing.T, home string, args []string, envExtra map[string]string) *proc {
	t.Helper()
	if home == "" {
		home = t.TempDir()
	}
	filtered := filteredEnv(t)
	p := &proc{t: t}
	p.cmd = exec.Command(exePath, args...)
	p.cmd.Dir = home
	env := append(filtered,
		"GCODE_API_KEY=test-key",
		"GCODE_BASE_URL="+serverURL,
		"GCODE_MODEL=fake-model",
		"HOME="+home,
		"USERPROFILE="+home,
	)
	for k, v := range envExtra {
		env = append(env, k+"="+v)
	}
	p.cmd.Env = env

	var err error
	p.stdin, err = p.cmd.StdinPipe()
	if err != nil {
		t.Fatalf("stdin 管道失败：%v", err)
	}
	stdout, _ := p.cmd.StdoutPipe()
	stderr, _ := p.cmd.StderrPipe()
	p.cmd.Start()
	go func() {
		_, _ = io.Copy(&p.out, stdout)
	}()
	go func() {
		_, _ = io.Copy(&p.out, stderr)
	}()
	t.Cleanup(func() {
		_ = p.stdin.Close()
		if p.cmd.Process != nil {
			_ = p.cmd.Process.Kill()
			_, _ = p.cmd.Process.Wait()
		}
	})
	return p
}

// filteredEnv 继承系统环境但去掉会干扰隔离的变量。
func filteredEnv(t *testing.T) []string {
	t.Helper()
	var out []string
	for _, kv := range os.Environ() {
		key := strings.SplitN(kv, "=", 2)[0]
		if key == "HOME" || key == "USERPROFILE" || strings.HasPrefix(key, "GCODE_") {
			continue
		}
		out = append(out, kv)
	}
	return out
}

func (p *proc) write(s string) {
	p.t.Helper()
	if _, err := io.WriteString(p.stdin, s+"\n"); err != nil {
		p.t.Fatalf("写 stdin 失败：%v", err)
	}
}

func (p *proc) snapshot() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.out.String()
}

// waitContains 等输出里出现 substr。
func (p *proc) waitContains(substr string, timeout time.Duration) {
	p.t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if strings.Contains(p.snapshot(), substr) {
			return
		}
		if time.Now().After(deadline) {
			p.t.Fatalf("等不到输出 %q；已有：\n%s", substr, truncateOut(p.snapshot()))
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// waitContainsN 等输出里 substr 出现至少 n 次（用于第二轮同名提示）。
func (p *proc) waitContainsN(substr string, n int, timeout time.Duration) {
	p.t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if strings.Count(p.snapshot(), substr) >= n {
			return
		}
		if time.Now().After(deadline) {
			p.t.Fatalf("等不到输出 %q ×%d；已有：\n%s", substr, n, truncateOut(p.snapshot()))
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// sendExit 写 /exit 并等进程退出。
func (p *proc) sendExit() {
	p.t.Helper()
	_, _ = io.WriteString(p.stdin, "/exit\n")
	done := make(chan struct{})
	go func() {
		_ = p.cmd.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		p.t.Fatalf("子进程未在 5s 内退出；输出：\n%s", truncateOut(p.snapshot()))
	}
}

func truncateOut(s string) string {
	if len(s) > 8000 {
		return s[:8000] + "\n…（冒烟输出过长已截断）"
	}
	return s
}

func bodiesSnapshot() int {
	bodiesMu.Lock()
	defer bodiesMu.Unlock()
	return len(bodies)
}

func bodyContains(from int, substrs ...string) bool {
	bodiesMu.Lock()
	defer bodiesMu.Unlock()
	for _, b := range bodies[from:] {
		all := true
		for _, s := range substrs {
			if !strings.Contains(b, s) {
				all = false
				break
			}
		}
		if all {
			return true
		}
	}
	return false
}

// bodiesFrom 返回第 from 个之后的请求体副本（供负向断言遍历）。
func bodiesFrom(from int) []string {
	bodiesMu.Lock()
	defer bodiesMu.Unlock()
	return append([]string(nil), bodies[from:]...)
}

func assertContains(t *testing.T, out string, subs ...string) {
	t.Helper()
	for _, s := range subs {
		if !strings.Contains(out, s) {
			t.Fatalf("输出缺 %q；实际：\n%s", s, truncateOut(out))
		}
	}
}

// ---------- 场景 ----------

// A：--yolo 工具闭环——流式正文 → 工具调用 → bash 执行 → 结果回流 → 最终回答。
func TestSmokeAToolLoop(t *testing.T) {
	p := startGocode(t, "", []string{"--yolo"}, nil)
	p.write("跑一下冒烟测试")
	p.waitContains("验证完成：smoke-ok", 30*time.Second)
	p.write("/exit")
	p.sendExit()

	out := p.snapshot()
	assertContains(t, out, "我先跑个命令确认环境。", "验证完成：smoke-ok", "exit=0", "smoke-ok")
	if !bodyContains(0, `"role":"tool"`, "smoke-ok") {
		t.Fatalf("A: 第二轮请求未携带工具结果")
	}
}

// B：/resume 恢复会话并携带历史发给模型。
func TestSmokeBResume(t *testing.T) {
	home := t.TempDir()
	// 先造一个有历史的会话（复用 A 的剧本）
	p0 := startGocode(t, home, []string{"--yolo"}, nil)
	p0.write("跑一下冒烟测试")
	p0.waitContains("验证完成：smoke-ok", 30*time.Second)
	p0.write("/exit")
	p0.sendExit()

	before := bodiesSnapshot()
	p := startGocode(t, home, nil, nil)
	p.write("/resume")
	p.waitContains("最近的会话", 15*time.Second)
	p.write("/resume 1")
	p.waitContains("已恢复", 15*time.Second)
	p.write("继续")
	p.waitContains("好的，继续。", 30*time.Second)
	p.write("/exit")
	p.sendExit()

	out := p.snapshot()
	assertContains(t, out, "最近的会话", "跑一下冒烟测试", "已恢复", "好的，继续。")
	if !bodyContains(before, "跑一下冒烟测试", "继续") {
		t.Fatalf("B: 恢复的历史未随新请求发给模型")
	}
}

// C：Anthropic 协议（BASE_URL 含 /anthropic 自动识别）完整工具轮，含分片 input_json_delta。
func TestSmokeCAnthropic(t *testing.T) {
	before := bodiesSnapshot()
	p := startGocode(t, "", []string{"--yolo"}, map[string]string{"GCODE_BASE_URL": serverURL + "/anthropic"})
	p.write("跑一下 Anthropic 冒烟")
	p.waitContains("验证完成：smoke-anthropic", 30*time.Second)
	p.write("/exit")
	p.sendExit()

	out := p.snapshot()
	assertContains(t, out, "我先跑个命令确认环境。", "验证完成：smoke-anthropic", "smoke-anthropic")
	if !bodyContains(before, `"tool_result"`, "smoke-anthropic") {
		t.Fatalf("C: 第二轮请求未携带 tool_result")
	}
	if !bodyContains(before, `"input_schema"`, `"max_tokens"`, `"system"`) {
		t.Fatalf("C: 请求缺 Anthropic 必备字段（input_schema/max_tokens/system）")
	}
}

// D：诱导 web_fetch 抓内网地址，断言 SSRF 拦截且结果回流、会话正常收尾。
func TestSmokeDSSRFBlock(t *testing.T) {
	before := bodiesSnapshot()
	p := startGocode(t, "", []string{"--yolo"}, nil)
	p.write("试试抓取 http://127.0.0.1:9/private")
	p.waitContains("已拦截", 30*time.Second)
	p.waitContains("验证完成：smoke-ok", 30*time.Second)
	p.write("/exit")
	p.sendExit()

	assertContains(t, p.snapshot(), "SSRF 防护")
	if !bodyContains(before, `"role":"tool"`, "SSRF 防护") {
		t.Fatalf("D: 拦截结果未回流给模型")
	}
}

// F：无 --yolo，stdin 喂 y/n 断言权限 allow/deny 两轮。
func TestSmokeFPermission(t *testing.T) {
	before := bodiesSnapshot()
	p := startGocode(t, "", nil, nil)
	p.write("跑一下冒烟测试")
	p.waitContains("允许?", 30*time.Second)            // 第一轮：bash 权限询问
	assertContains(t, p.snapshot(), "echo smoke-ok") // 预览应含将执行的命令
	p.write("y")
	p.waitContains("验证完成：smoke-ok", 30*time.Second)

	p.write("再来一次")
	p.waitContainsN("允许?", 2, 30*time.Second) // 第二轮：同名询问（计数区分）
	p.write("n")
	p.waitContains("用户已拒绝", 30*time.Second)
	p.write("/exit")
	p.sendExit()

	if !bodyContains(before, "用户拒绝了本次操作") {
		t.Fatalf("F: 拒绝回执未回流给模型")
	}
}

// G：三轮对话喂足历史 → /compact 压成摘要 → 压缩后凭摘要答出暗号，且后续请求不再携带原始历史。
func TestSmokeGCompact(t *testing.T) {
	before := bodiesSnapshot()
	p := startGocode(t, "", []string{"--yolo"}, nil)
	p.write("对话一：暗号是 smoke-secret")
	p.waitContainsN("好的，已记下。", 1, 30*time.Second)
	p.write("对话二：随便聊聊")
	p.waitContainsN("好的，已记下。", 2, 30*time.Second)
	p.write("对话三：收个尾")
	p.waitContainsN("好的，已记下。", 3, 30*time.Second)

	p.write("/compact")
	p.waitContains("已压缩：替换为任务摘要，节省约", 30*time.Second)
	afterCompact := bodiesSnapshot()

	p.write("暗号是什么")
	p.waitContains("暗号是 smoke-secret", 30*time.Second)
	p.write("/exit")
	p.sendExit()

	out := p.snapshot()
	assertContains(t, out, "已压缩：替换为任务摘要，节省约", "暗号是 smoke-secret")
	if !bodyContains(afterCompact, "此前对话的摘要") {
		t.Fatalf("G: 压缩后的请求未携带摘要消息")
	}
	if !bodyContains(before, "压缩成一份简洁的任务摘要") {
		t.Fatalf("G: /compact 未向模型发出摘要请求")
	}
	// 压缩后的任何请求都不应再携带原始三轮原文（摘要替换历史的正向验证）
	for i, b := range bodiesFrom(afterCompact) {
		if strings.Contains(b, "对话一：暗号") {
			t.Fatalf("G: 压缩后第 %d 个请求仍携带原始对话历史", i)
		}
	}
}

// H：exec 位置参数形态——`gcode exec --yolo "任务"` 无交互跑通工具闭环
// （[tool]/[result] 纯文本行 + 最终回答），进程以退出码 0 收尾。
func TestSmokeHExec(t *testing.T) {
	before := bodiesSnapshot()
	home := t.TempDir()
	cmd := exec.Command(exePath, "exec", "--yolo", "跑一下冒烟测试")
	cmd.Dir = home
	cmd.Env = append(filteredEnv(t),
		"GCODE_API_KEY=test-key",
		"GCODE_BASE_URL="+serverURL,
		"GCODE_MODEL=fake-model",
		"HOME="+home,
		"USERPROFILE="+home,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("exec 应以 0 退出，got %v；输出：\n%s", err, truncateOut(string(out)))
	}
	assertContains(t, string(out),
		"我先跑个命令确认环境。",     // 流式正文直写
		"[tool] bash",     // 工具调用行
		"[result] exit=0", // 工具结果行（bash 输出首行）
		"验证完成：smoke-ok",   // 最终回答
	)
	if !bodyContains(before, `"role":"tool"`, "smoke-ok") {
		t.Fatalf("H: 第二轮请求未携带工具结果")
	}
}

// H 反例：exec 不带 --yolo 必须拒绝执行并以退出码 1 收尾（无交互环境无法逐次确认）。
func TestSmokeHExecRequiresYolo(t *testing.T) {
	home := t.TempDir()
	cmd := exec.Command(exePath, "exec", "跑一下冒烟测试")
	cmd.Dir = home
	cmd.Env = append(filteredEnv(t),
		"GCODE_API_KEY=test-key",
		"GCODE_BASE_URL="+serverURL,
		"GCODE_MODEL=fake-model",
		"HOME="+home,
		"USERPROFILE="+home,
	)
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("exec 缺 --yolo 应以 1 退出，实际退出 0；输出：\n%s", truncateOut(string(out)))
	}
	assertContains(t, string(out), "--yolo")
}
