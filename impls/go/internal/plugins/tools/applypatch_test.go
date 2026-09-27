// apply_patch 原子补丁单测：全预验通过才写入；任一失败零写入并逐条报告
// （对齐 tcode/test/patch.test.ts）。
package tools

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func patchSetup(t *testing.T) (dir, a, b string) {
	t.Helper()
	dir = t.TempDir()
	a = filepath.Join(dir, "a.txt")
	b = filepath.Join(dir, "b.txt")
	if err := os.WriteFile(a, []byte("alpha\nbeta\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(b, []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir, a, b
}

func TestApplyPatchMultiFileOneShot(t *testing.T) {
	_, a, b := patchSetup(t)
	result := NewApplyPatch().Run(nil, map[string]any{
		"edits": []any{
			map[string]any{"file_path": a, "old_string": "alpha", "new_string": "ALPHA"},
			map[string]any{"file_path": b, "old_string": "hello", "new_string": "HELLO"},
		},
	})
	if !strings.Contains(result, "已应用补丁：2 处编辑") {
		t.Fatalf("返回串应含 已应用补丁：2 处编辑，got %q", result)
	}
	if got := readFileFor(t, a); got != "ALPHA\nbeta\n" {
		t.Fatalf("a.txt 内容不符，got %q", got)
	}
	if got := readFileFor(t, b); got != "HELLO\n" {
		t.Fatalf("b.txt 内容不符，got %q", got)
	}
}

func TestApplyPatchAnyFailureZeroWrite(t *testing.T) {
	_, a, b := patchSetup(t)
	result := NewApplyPatch().Run(nil, map[string]any{
		"edits": []any{
			map[string]any{"file_path": a, "old_string": "alpha", "new_string": "ALPHA"},
			map[string]any{"file_path": b, "old_string": "不存在的原文", "new_string": "X"},
		},
	})
	if !strings.Contains(result, "预验未通过") {
		t.Fatalf("返回串应含 预验未通过，got %q", result)
	}
	if !strings.Contains(result, "未找到 old_string") {
		t.Fatalf("返回串应含 未找到 old_string，got %q", result)
	}
	if got := readFileFor(t, a); got != "alpha\nbeta\n" {
		t.Fatalf("失败时 a 不应被改动，got %q", got)
	}
	if got := readFileFor(t, b); got != "hello\n" {
		t.Fatalf("b 不应被改动，got %q", got)
	}
}

func TestApplyPatchMultipleOccurrencesRejected(t *testing.T) {
	_, a, _ := patchSetup(t)
	result := NewApplyPatch().Run(nil, map[string]any{
		"edits": []any{
			map[string]any{"file_path": a, "old_string": "a", "new_string": "A"},
		},
	})
	if !strings.Contains(result, "出现 3 次") {
		t.Fatalf("返回串应含 出现 3 次，got %q", result)
	}
	if got := readFileFor(t, a); got != "alpha\nbeta\n" {
		t.Fatalf("拒绝时不应写入，got %q", got)
	}
}

func readFileFor(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
