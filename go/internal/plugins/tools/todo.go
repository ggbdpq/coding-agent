// todo 工具：会话内任务清单——插件 API 的活样例（"加一个工具"的模板）。
// 状态存在构造函数闭包里：进程内存活，/new 不清空、退出即失；
// 刻意做小，只演示"加一个工具 = 加一个文件 + 清单一行"。
package tools

import (
	"fmt"
	"strings"

	"gocode/internal/kernel"
)

type todoItem struct {
	id   int
	text string
	done bool
}

// NewTodo 构造 todo 工具插件（每次调用得到独立状态）。
func NewTodo() *kernel.ToolDef {
	var items []todoItem
	nextID := 1
	return &kernel.ToolDef{
		Name:        "todo",
		Description: "维护会话内任务清单（add/list/done/clear），多步任务时用来跟踪进度。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"action": map[string]any{"type": "string", "enum": []string{"add", "list", "done", "clear"}, "description": "操作"},
				"text":   map[string]any{"type": "string", "description": "add 时的任务内容"},
				"id":     map[string]any{"type": "number", "description": "done 时的任务编号"},
			},
			"required": []string{"action"},
		},
		NeedsPermission: false,
		Preview:         func(args map[string]any) string { return "todo " + argString(args, "action") },
		Run: func(args map[string]any) string {
			action := argString(args, "action")
			if action == "" {
				action = "list"
			}
			switch action {
			case "add":
				text := strings.TrimSpace(argString(args, "text"))
				if text == "" {
					return "错误：add 需要 text"
				}
				id := nextID
				nextID++
				items = append(items, todoItem{id: id, text: text})
				return fmt.Sprintf("已添加 #%d：%s", id, text)
			case "done":
				id := int(argNumber(args, "id", 0))
				for i := range items {
					if items[i].id == id {
						items[i].done = true
						return fmt.Sprintf("已完成 #%d：%s", items[i].id, items[i].text)
					}
				}
				return fmt.Sprintf("错误：没有 #%d 这条任务", id)
			case "clear":
				n := len(items)
				items = nil
				return fmt.Sprintf("已清空 %d 条任务", n)
			}
			if len(items) == 0 {
				return "（清单为空）"
			}
			var b strings.Builder
			for _, it := range items {
				mark := "[ ]"
				if it.done {
					mark = "[x]"
				}
				fmt.Fprintf(&b, "%s #%d %s\n", mark, it.id, it.text)
			}
			return strings.TrimRight(b.String(), "\n")
		},
	}
}
