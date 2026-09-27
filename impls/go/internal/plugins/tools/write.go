// write 工具：整文件写入（新文件/整体重写），自动建父目录。
// 模型给的路径先过路径守卫：越出工作目录的目标在权限确认时醒目提示，由人工把关。
package tools

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"gcode/internal/kernel"
)

// NewWrite 构造 write 工具插件。
func NewWrite() *kernel.ToolDef {
	return &kernel.ToolDef{
		Name:        "write",
		Description: "将内容写入文件（整体覆盖，自动创建父目录）。修改已有文件请优先用 edit 做精确替换。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"file_path": map[string]any{"type": "string", "description": "目标文件路径"},
				"content":   map[string]any{"type": "string", "description": "完整文件内容"},
			},
			"required": []string{"file_path", "content"},
		},
		NeedsPermission: true,
		SkipPermission: func(args map[string]any, app *kernel.App) bool {
			return InAllowWriteDirs(app, argString(args, "file_path"))
		},
		Preview: func(args map[string]any) string {
			outside := ResolvePath(argString(args, "file_path")).Outside
			flag := ""
			if outside {
				flag = "\n⚠ 注意：该路径在当前工作目录之外！"
			}
			return fmt.Sprintf("写入 %s%s\n%s", argString(args, "file_path"), flag,
				kernel.Ellipsis(argString(args, "content"), 4000))
		},
		Run: func(_ context.Context, args map[string]any) string { return runWrite(args) },
	}
}

func runWrite(args map[string]any) string {
	file := argString(args, "file_path")
	if file == "" {
		return "错误：缺少 file_path"
	}
	text, ok := args["content"].(string)
	if !ok {
		return "错误：缺少 content"
	}
	abs := ResolvePath(file).Abs
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return fmt.Sprintf("错误：创建父目录失败：%s", err)
	}
	if err := os.WriteFile(abs, []byte(text), 0o644); err != nil {
		return fmt.Sprintf("错误：写入失败：%s", err)
	}
	lines := strings.Count(text, "\n") + 1
	return fmt.Sprintf("已写入 %s（%d 字符 / %d 行）", file, utf8.RuneCountInString(text), lines)
}
