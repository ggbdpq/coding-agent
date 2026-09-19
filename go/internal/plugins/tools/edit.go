// edit 工具：精确字符串替换——coding agent 改代码的主力。
// old_string 必须在文件中唯一（否则要求补上下文或显式 replace_all），防止误伤。
// ApplyEdit 是纯函数（可单测）；工具壳 NewEdit 在同文件下半部分。
package tools

import (
	"context"
	"fmt"
	"os"
	"strings"

	"gcode/internal/kernel"
)

// EditResult ApplyEdit 的判定结果：OK=false 时 Message 为错误信息。
type EditResult struct {
	OK      bool
	Message string // OK 时为替换档位（one/all），否则为错误信息
}

// ApplyEdit 纯函数：对 content 做一次精确替换的唯一性判定与档位归类。
func ApplyEdit(content, oldString, newString string, replaceAll bool) EditResult {
	_ = newString // 判定只关心唯一性；实际替换由调用方执行
	if oldString == "" {
		return EditResult{OK: false, Message: "错误：old_string 不能为空"}
	}
	count := strings.Count(content, oldString)
	if count == 0 {
		return EditResult{OK: false, Message: "错误：未找到 old_string，请先 read 文件核对精确内容（含缩进与换行）"}
	}
	if count > 1 && !replaceAll {
		return EditResult{OK: false, Message: fmt.Sprintf("错误：old_string 出现了 %d 次。请加入更多上下文使其唯一；确认要全部替换时设 replace_all=true", count)}
	}
	if replaceAll {
		return EditResult{OK: true, Message: "all"}
	}
	return EditResult{OK: true, Message: "one"}
}

// NewEdit 构造 edit 工具插件。
func NewEdit() *kernel.ToolDef {
	return &kernel.ToolDef{
		Name: "edit",
		Description: "对文件做精确字符串替换：old_string 必须与文件内容完全一致（含缩进）。" +
			"多处出现且需全部替换时设 replace_all=true。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"file_path":   map[string]any{"type": "string", "description": "目标文件路径"},
				"old_string":  map[string]any{"type": "string", "description": "要被替换的精确原文"},
				"new_string":  map[string]any{"type": "string", "description": "替换后的新文本"},
				"replace_all": map[string]any{"type": "boolean", "description": "全部替换，默认 false"},
			},
			"required": []string{"file_path", "old_string", "new_string"},
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
			return fmt.Sprintf("编辑 %s%s\n%s",
				argString(args, "file_path"), flag,
				kernel.PreviewDiff(argString(args, "old_string"), argString(args, "new_string"), 40))
		},
		Run: func(_ context.Context, args map[string]any) string { return runEdit(args) },
	}
}

// runEdit 工具壳：读文件 → ApplyEdit 判定 → 替换 → 写回。
func runEdit(args map[string]any) string {
	file := argString(args, "file_path")
	oldString := argString(args, "old_string")
	newString := argString(args, "new_string")
	replaceAll := argBool(args, "replace_all")
	if file == "" {
		return "错误：缺少 file_path"
	}
	abs := ResolvePath(file).Abs
	content, err := os.ReadFile(abs)
	if err != nil {
		return fmt.Sprintf("错误：无法读取 %s（不存在或不可读）", file)
	}
	text := string(content)
	check := ApplyEdit(text, oldString, newString, replaceAll)
	if !check.OK {
		return check.Message
	}
	var next string
	if replaceAll {
		next = strings.ReplaceAll(text, oldString, newString)
	} else {
		next = strings.Replace(text, oldString, newString, 1)
	}
	if err := os.WriteFile(abs, []byte(next), 0o644); err != nil {
		return fmt.Sprintf("错误：写入失败：%s", err)
	}
	count := 1
	if replaceAll {
		count = strings.Count(text, oldString)
	}
	return fmt.Sprintf("已替换 %s 中 %d 处内容", file, count)
}
