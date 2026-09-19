// todo 工具：会话内任务清单——插件 API 的活样例（"加一个工具"的模板）。
// 状态存在构造闭包里：进程内存活，/new 不清空、退出即失；
// 刻意做小，只演示"加一个工具 = 加一个文件 + 清单一行"。
use std::cell::RefCell;
use std::rc::Rc;

use serde_json::Value;

use super::{arg_number, arg_str};
use crate::kernel::plugin::{Plugin, ToolDef};

struct TodoItem {
    id: i64,
    text: String,
    done: bool,
}

#[derive(Default)]
struct TodoState {
    items: Vec<TodoItem>,
    next_id: i64,
}

pub fn todo_plugin() -> Plugin {
    let state = Rc::new(RefCell::new(TodoState { items: Vec::new(), next_id: 1 }));
    Plugin::Tool(Rc::new(ToolDef {
        name: "todo",
        description: "维护会话内任务清单（add/list/done/clear），多步任务时用来跟踪进度。",
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["add", "list", "done", "clear"], "description": "操作"},
                "text": {"type": "string", "description": "add 时的任务内容"},
                "id": {"type": "number", "description": "done 时的任务编号"}
            },
            "required": ["action"]
        }),
        needs_permission: false,
        preview: Rc::new(|args: &Value| format!("todo {}", arg_str(args, "action"))),
        run: {
            let state = state.clone();
            Rc::new(move |args: &Value| run_todo(&state, args))
        },
        skip_permission: None,
    }))
}

fn run_todo(state: &Rc<RefCell<TodoState>>, args: &Value) -> String {
    let mut action = arg_str(args, "action");
    if action.is_empty() {
        action = "list".to_string();
    }
    let mut st = state.borrow_mut();
    match action.as_str() {
        "add" => {
            let text = arg_str(args, "text").trim().to_string();
            if text.is_empty() {
                return "错误：add 需要 text".to_string();
            }
            let id = st.next_id;
            st.next_id += 1;
            st.items.push(TodoItem { id, text: text.clone(), done: false });
            format!("已添加 #{}：{}", id, text)
        }
        "done" => {
            let id = arg_number(args, "id", 0.0) as i64;
            if let Some(it) = st.items.iter_mut().find(|i| i.id == id) {
                it.done = true;
                return format!("已完成 #{}：{}", it.id, it.text);
            }
            format!("错误：没有 #{} 这条任务", id)
        }
        "clear" => {
            let n = st.items.len();
            st.items.clear();
            format!("已清空 {} 条任务", n)
        }
        _ => {
            if st.items.is_empty() {
                return "（清单为空）".to_string();
            }
            st.items
                .iter()
                .map(|i| format!("{} #{} {}", if i.done { "[x]" } else { "[ ]" }, i.id, i.text))
                .collect::<Vec<_>>()
                .join("\n")
        }
    }
}
