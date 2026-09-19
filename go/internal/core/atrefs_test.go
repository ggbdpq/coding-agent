// @文件引用单测（对齐 tcode/test/atrefs.test.ts）：内容注入、缺失标注、多引用、256KB 截断。
package core

import (
	"strings"
	"testing"
)

// fakeRead 测试注入的读文件函数：查表返回，查不到 ok=false。
func fakeRead(files map[string]string) func(string) (string, bool) {
	return func(p string) (string, bool) {
		c, ok := files[p]
		return c, ok
	}
}

func TestExpandAtRefsNoRefs(t *testing.T) {
	in := "邮箱 someone@example.com 保持原样"
	if got := ExpandAtRefs(in, fakeRead(nil)); got != in {
		t.Fatalf("无 @ 引用应原样返回，got %q", got)
	}
}

func TestExpandAtRefsInjectsContent(t *testing.T) {
	out := ExpandAtRefs("看看 @src/a.ts 说明了什么", fakeRead(map[string]string{"src/a.ts": "hello"}))
	for _, want := range []string{"看看", "[引用文件 src/a.ts]", "hello", "[/引用文件]"} {
		if !strings.Contains(out, want) {
			t.Fatalf("输出缺 %q，got %q", want, out)
		}
	}
}

func TestExpandAtRefsMultiple(t *testing.T) {
	out := ExpandAtRefs("@a.txt 和 @b.txt", fakeRead(map[string]string{"a.txt": "AAA", "b.txt": "BBB"}))
	if !strings.Contains(out, "AAA") || !strings.Contains(out, "BBB") {
		t.Fatalf("多个引用应各自注入，got %q", out)
	}
}

func TestExpandAtRefsMissingFile(t *testing.T) {
	out := ExpandAtRefs("看看 @ghost.ts", fakeRead(nil))
	if !strings.Contains(out, "（文件不存在）") {
		t.Fatalf("缺文件应标注缺失而非报错，got %q", out)
	}
}

func TestExpandAtRefsTruncates(t *testing.T) {
	out := ExpandAtRefs("看 @big.txt", fakeRead(map[string]string{"big.txt": strings.Repeat("x", 300_000)}))
	if len(out) >= 300_000 {
		t.Fatalf("超长文件应被截断，got %d 字符", len(out))
	}
	if !strings.Contains(out, "已截断") {
		t.Fatalf("截断应有标注，got 末尾 %q", out[max(0, len(out)-60):])
	}
}
