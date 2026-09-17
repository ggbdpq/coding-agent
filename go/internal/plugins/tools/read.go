// read 工具：带行号读文件，支持 offset/limit 分段；超大文件拒读并提示分段。
// 路径先过守卫统一解析（读操作免确认，但解析规则与写类保持一致）。
package tools

import (
	"fmt"
	"os"
	"strings"

	"gocode/internal/kernel"
)

const (
	readMaxBytes = 1024 * 1024
	readDefaultN = 2000
)

// NewRead 构造 read 工具插件。
func NewRead() *kernel.ToolDef {
	return &kernel.ToolDef{
		Name:        "read",
		Description: "读取文件内容，带行号（1-based）。大文件可用 offset（起始行）和 limit（最多行数）分段读取。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"file_path": map[string]any{"type": "string", "description": "文件路径，相对当前目录或绝对路径"},
				"offset":    map[string]any{"type": "number", "description": "起始行号（1-based），默认 1"},
				"limit":     map[string]any{"type": "number", "description": fmt.Sprintf("最多读取行数，默认 %d", readDefaultN)},
			},
			"required": []string{"file_path"},
		},
		NeedsPermission: false,
		Preview:         func(args map[string]any) string { return "read " + argString(args, "file_path") },
		Run:             func(args map[string]any) string { return runRead(args) },
	}
}

func runRead(args map[string]any) string {
	file := argString(args, "file_path")
	if file == "" {
		return "错误：缺少 file_path"
	}
	abs := ResolvePath(file).Abs
	st, err := os.Stat(abs)
	if err != nil {
		return fmt.Sprintf("错误：文件不存在：%s", file)
	}
	if st.IsDir() {
		return fmt.Sprintf("错误：%s 是目录，请用 glob 列文件", file)
	}
	if st.Size() > readMaxBytes {
		return fmt.Sprintf("错误：文件过大（%d 字节，上限 %d），请用 offset/limit 分段读取", st.Size(), readMaxBytes)
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return fmt.Sprintf("错误：读取失败：%s", err)
	}
	lines := strings.Split(string(data), "\n")
	total := len(lines)
	offset := int(argNumber(args, "offset", 1)) - 1
	start := offset
	if start > total-1 {
		start = total - 1
	}
	if start < 0 {
		start = 0
	}
	limit := int(argNumber(args, "limit", readDefaultN))
	if limit < 1 {
		limit = 1
	}
	end := start + limit
	if end > total {
		end = total
	}
	var b strings.Builder
	for i := start; i < end; i++ {
		fmt.Fprintf(&b, "%6d\t%s\n", i+1, lines[i])
	}
	body := strings.TrimRight(b.String(), "\n")
	if end < total {
		note := fmt.Sprintf("\n（已显示第 %d-%d 行，共 %d 行；继续读请调大 offset）", start+1, end, total)
		return body + note
	}
	return body
}
