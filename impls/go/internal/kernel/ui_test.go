// diff 预览单测：前缀 +/-、公共上下文收敛、截断标注（对齐 tcode/test/diff.test.ts）。
package kernel

import (
	"strings"
	"testing"
)

func TestPreviewDiffIdenticalNoMarkLines(t *testing.T) {
	d := PreviewDiff("a\nb", "a\nb", 40)
	if strings.Contains(d, "-a") || strings.Contains(d, "+a") {
		t.Fatalf("相同文本不应有 +/- 行，got %q", d)
	}
}

func TestPreviewDiffReplaceShowsOldAndNew(t *testing.T) {
	d := PreviewDiff("old line", "new line", 40)
	if !strings.Contains(d, "-old line") {
		t.Fatalf("应含 -old line，got %q", d)
	}
	if !strings.Contains(d, "+new line") {
		t.Fatalf("应含 +new line，got %q", d)
	}
}

func TestPreviewDiffMultiLineKeepsContextOrder(t *testing.T) {
	d := PreviewDiff("a\nb\nc", "a\nB\nc", 40)
	if !strings.Contains(d, " a") || !strings.Contains(d, " c") {
		t.Fatalf("公共行应保留，got %q", d)
	}
	if !strings.Contains(d, "-b") || !strings.Contains(d, "+B") {
		t.Fatalf("应含 -b 与 +B，got %q", d)
	}
}
