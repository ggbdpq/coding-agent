// write 工具：整文件写入（新文件/整体重写），自动建父目录。
// 模型给的路径先过路径守卫：越出工作目录的目标在权限确认时醒目提示，由人工把关。
use std::rc::Rc;

use serde_json::Value;

use super::{arg_str, pathguard::resolve_path};
use crate::kernel::plugin::{Plugin, ToolDef};
use crate::kernel::ui::ellipsis;

pub fn write_plugin() -> Plugin {
    Plugin::Tool(Rc::new(ToolDef {
        name: "write",
        description: "将内容写入文件（整体覆盖，自动创建父目录）。修改已有文件请优先用 edit 做精确替换。",
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "目标文件路径"},
                "content": {"type": "string", "description": "完整文件内容"}
            },
            "required": ["file_path", "content"]
        }),
        needs_permission: true,
        preview: Rc::new(|args: &Value| {
            let file = arg_str(args, "file_path");
            let flag = if resolve_path(&file).outside { "\n⚠ 注意：该路径在当前工作目录之外！" } else { "" };
            format!("写入 {}{}\n{}", file, flag, ellipsis(&arg_str(args, "content"), 4000))
        }),
        run: Rc::new(|args: &Value| run_write(args)),
    }))
}

fn run_write(args: &Value) -> String {
    let file = arg_str(args, "file_path");
    if file.is_empty() {
        return "错误：缺少 file_path".to_string();
    }
    let text = match args.get("content").and_then(Value::as_str) {
        Some(t) => t.to_string(),
        None => return "错误：缺少 content".to_string(),
    };
    let abs = resolve_path(&file).abs;
    if let Some(parent) = abs.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return format!("错误：创建父目录失败：{}", e);
        }
    }
    if let Err(e) = std::fs::write(&abs, &text) {
        return format!("错误：写入失败：{}", e);
    }
    let lines = text.matches('\n').count() + 1;
    format!("已写入 {}（{} 字符 / {} 行）", file, text.chars().count(), lines)
}
