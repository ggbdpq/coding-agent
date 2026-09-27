// 审批白名单单测（R4，对齐 tcode/test/approval.test.ts）：allowWriteDirs 内的
// write/edit 免确认、外必问、未配置一律问；bash/web_fetch 不设白名单。
package tools

import (
	"path/filepath"
	"testing"

	"gcode/internal/kernel"
)

func allowWriteApp(dirs ...string) *kernel.App {
	return &kernel.App{
		Config: &kernel.Config{AllowWriteDirs: dirs},
		Yolo:   &kernel.YoloRef{},
	}
}

func TestSkipPermissionInsideAllowWriteDirs(t *testing.T) {
	dir := t.TempDir() // 已是归一化绝对路径
	app := allowWriteApp(dir)
	target := filepath.Join(dir, "out.txt")
	if !NewWrite().SkipPermission(map[string]any{"file_path": target}, app) {
		t.Fatalf("白名单目录内的 write 应免确认")
	}
}

func TestSkipPermissionOutsideAllowWriteDirs(t *testing.T) {
	app := allowWriteApp(t.TempDir())
	target := filepath.Join(t.TempDir(), "out.txt") // 另一个不相干目录
	if NewWrite().SkipPermission(map[string]any{"file_path": target}, app) {
		t.Fatalf("白名单外的 write 仍需确认")
	}
}

func TestSkipPermissionUnconfiguredAlwaysAsk(t *testing.T) {
	app := allowWriteApp()
	target := filepath.Join(t.TempDir(), "out.txt")
	if NewWrite().SkipPermission(map[string]any{"file_path": target}, app) {
		t.Fatalf("未配置白名单时应一律确认")
	}
}

func TestSkipPermissionEditInsideAllowWriteDirs(t *testing.T) {
	dir := t.TempDir()
	app := allowWriteApp(dir)
	if !NewEdit().SkipPermission(map[string]any{"file_path": filepath.Join(dir, "a.go")}, app) {
		t.Fatalf("白名单内的 edit 应免确认")
	}
}

func TestBashAndWebFetchHaveNoSkipPermission(t *testing.T) {
	if NewBash().SkipPermission != nil {
		t.Fatalf("bash 不应设白名单免确认（命令级操作无法按路径约束）")
	}
	if NewWebFetch().SkipPermission != nil {
		t.Fatalf("web_fetch 不应设白名单免确认（命令级操作无法按路径约束）")
	}
}
