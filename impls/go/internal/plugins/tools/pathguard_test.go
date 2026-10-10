package tools

import (
	"os"
	"path/filepath"
	"testing"
)

// 工作目录 / 白名单目录里的符号链接指向外部时，越界判定必须按链接的真实目标算。
//
//nolint:paralleltest // t.Chdir 改进程工作目录，不能并行。
func TestPathGuardFollowsSymlinks(t *testing.T) {
	work := t.TempDir()
	outside := t.TempDir()

	for name, dst := range map[string]string{
		"link":     outside,
		"dangling": filepath.Join(outside, "not-yet.txt"),
	} {
		if err := os.Symlink(dst, filepath.Join(work, name)); err != nil {
			t.Skipf("无法创建符号链接: %v", err)
		}
	}

	if err := os.Mkdir(filepath.Join(work, "..foo"), 0o750); err != nil {
		t.Fatal(err)
	}

	t.Chdir(work)

	cases := []struct {
		path        string
		wantOutside bool
	}{
		{"plain.txt", false},
		{"sub/new.txt", false},
		{"..foo/a.txt", false},
		{"../x.txt", true},
		{"link/x.txt", true},
		{"dangling", true},
	}
	app := allowWriteApp(work)

	for _, tc := range cases {
		if got := ResolvePath(tc.path).Outside; got != tc.wantOutside {
			t.Errorf("ResolvePath(%q).Outside = %v, want %v", tc.path, got, tc.wantOutside)
		}

		if got := InAllowWriteDirs(app, tc.path); got == tc.wantOutside {
			t.Errorf("InAllowWriteDirs(%q) = %v, want %v", tc.path, got, !tc.wantOutside)
		}
	}
}
