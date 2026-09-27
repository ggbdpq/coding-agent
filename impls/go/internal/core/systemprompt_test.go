// 技能索引错误契约：目录不可读（如指向文件/无权限）→ stderr 警告一行后跳过，
// 不静默也不打断启动（学自 ZCode skills/scan.ts，按 FreshMessages 闭包语境修订）。
package core

import (
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSkillIndexUnreadableDirWarnsAndSkips(t *testing.T) {
	if runtime.GOOS == "windows" {
		// Windows 的 os.ReadDir 指向文件不报错（返回空列表），警告分支无法便携触发；
		// 红能力在 POSIX runner 上成立，分支本身由源码 Fprintf 保证。
		t.Skip("Windows 上 ReadDir(文件) 不返回错误，跳过本测试")
	}
	f := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	// 捕获 stderr：临时替换 os.Stderr 为管道
	old := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = w
	got := SkillIndex([]string{f})
	w.Close()
	os.Stderr = old
	out, _ := io.ReadAll(r)

	if got != "" {
		t.Fatalf("不可读目录应被跳过，got %q", got)
	}
	if !strings.Contains(string(out), "skill 索引") {
		t.Fatalf("应输出 stderr 警告，got %q", string(out))
	}
}
