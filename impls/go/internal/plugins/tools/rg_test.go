package tools

import (
	"context"
	"os/exec"
	"strings"
	"testing"
)

// 用户中止（turnCtx 取消）后 grep/glob 不能照常跑完 rg 并返回结果。
func TestRgToolsStopWhenTurnCancelled(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg 不在 PATH")
	}

	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	cases := []struct {
		name string
		run  func() string
	}{
		{"grep", func() string { return NewGrep().Run(ctx, map[string]any{"pattern": "package", "path": "."}) }},
		{"glob", func() string { return NewGlob().Run(ctx, map[string]any{"pattern": "*.go"}) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			if out := tc.run(); !strings.Contains(out, "已中止") {
				t.Fatalf("取消后输出 = %.120q，want 含 已中止", out)
			}
		})
	}
}
