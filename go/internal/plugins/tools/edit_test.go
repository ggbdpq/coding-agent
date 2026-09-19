// edit 工具单测：唯一性判定是误伤防线，锁死行为（对齐 tcode/test/edit.test.ts）。
package tools

import (
	"strings"
	"testing"
)

func TestApplyEditUniqueMatch(t *testing.T) {
	r := ApplyEdit("const a = 1;\nconst b = 2;", "const b = 2;", "const b = 3;", false)
	if !r.OK {
		t.Fatalf("唯一匹配应成功，got %+v", r)
	}
	if r.Message != "one" {
		t.Fatalf("档位应为 one，got %q", r.Message)
	}
}

func TestApplyEditNotFound(t *testing.T) {
	r := ApplyEdit("hello", "world", "x", false)
	if r.OK {
		t.Fatalf("未找到应失败，got %+v", r)
	}
	if !strings.Contains(r.Message, "未找到") {
		t.Fatalf("错误信息应提示未找到，got %q", r.Message)
	}
}

func TestApplyEditMultipleWithoutReplaceAll(t *testing.T) {
	r := ApplyEdit("x = 1; x = 2;", "x = ", "y = ", false)
	if r.OK {
		t.Fatalf("多处出现未开 replace_all 应失败，got %+v", r)
	}
	if !strings.Contains(r.Message, "2 次") {
		t.Fatalf("错误信息应含出现次数，got %q", r.Message)
	}
}

func TestApplyEditReplaceAll(t *testing.T) {
	r := ApplyEdit("a\nb\na", "a", "c", true)
	if !r.OK {
		t.Fatalf("replace_all 档位应放行，got %+v", r)
	}
	if r.Message != "all" {
		t.Fatalf("档位应为 all，got %q", r.Message)
	}
}

func TestApplyEditEmptyOldString(t *testing.T) {
	r := ApplyEdit("abc", "", "x", false)
	if r.OK {
		t.Fatalf("空 old_string 应拒绝，got %+v", r)
	}
}
