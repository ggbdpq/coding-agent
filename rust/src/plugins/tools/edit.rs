// edit 工具：精确字符串替换——coding agent 改代码的主力。
// old_string 必须在文件中唯一（否则要求补上下文或显式 replace_all），防止误伤。
// apply_edit 是纯函数（TDD 接缝 1，可单测）；工具壳 edit_plugin 在下半部分。
use serde_json::Value;

use super::{arg_bool, arg_str, pathguard::resolve_path, truncate_runes};

/// apply_edit 的判定结果：ok=false 时 message 为错误信息。
#[derive(Debug, PartialEq)]
pub struct EditResult {
    pub ok: bool,
    /// ok 时为替换档位（one/all），否则为错误信息
    pub message: String,
}

/// 纯函数：对 content 做一次精确替换的唯一性判定与档位归类（不执行替换）。
pub fn apply_edit(content: &str, old_string: &str, _new_string: &str, replace_all: bool) -> EditResult {
    if old_string.is_empty() {
        return EditResult { ok: false, message: "错误：old_string 不能为空".to_string() };
    }
    let count = content.matches(old_string).count();
    if count == 0 {
        return EditResult {
            ok: false,
            message: "错误：未找到 old_string，请先 read 文件核对精确内容（含缩进与换行）".to_string(),
        };
    }
    if count > 1 && !replace_all {
        return EditResult {
            ok: false,
            message: format!(
                "错误：old_string 出现了 {} 次。请加入更多上下文使其唯一；确认要全部替换时设 replace_all=true",
                count
            ),
        };
    }
    EditResult { ok: true, message: if replace_all { "all".to_string() } else { "one".to_string() } }
}

/// edit 工具插件：读文件 → apply_edit 判定 → 替换 → 写回。
pub fn edit_plugin() -> crate::kernel::plugin::Plugin {
    crate::kernel::plugin::Plugin::Tool(std::rc::Rc::new(crate::kernel::plugin::ToolDef {
        name: "edit",
        description: "对文件做精确字符串替换：old_string 必须与文件内容完全一致（含缩进）。多处出现且需全部替换时设 replace_all=true。",
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "目标文件路径"},
                "old_string": {"type": "string", "description": "要被替换的精确原文"},
                "new_string": {"type": "string", "description": "替换后的新文本"},
                "replace_all": {"type": "boolean", "description": "全部替换，默认 false"}
            },
            "required": ["file_path", "old_string", "new_string"]
        }),
        needs_permission: true,
        preview: std::rc::Rc::new(|args: &Value| {
            let file = arg_str(args, "file_path");
            let flag = if resolve_path(&file).outside { "\n⚠ 注意：该路径在当前工作目录之外！" } else { "" };
            format!(
                "编辑 {}{}\n- {}\n+ {}",
                file,
                flag,
                truncate_runes(&arg_str(args, "old_string"), 800),
                truncate_runes(&arg_str(args, "new_string"), 800)
            )
        }),
        run: std::rc::Rc::new(|args: &Value| run_edit(args)),
    }))
}

/// 工具壳：读文件 → ApplyEdit 判定 → 替换 → 写回。
fn run_edit(args: &Value) -> String {
    let file = arg_str(args, "file_path");
    let old_string = arg_str(args, "old_string");
    let new_string = arg_str(args, "new_string");
    let replace_all = arg_bool(args, "replace_all");
    if file.is_empty() {
        return "错误：缺少 file_path".to_string();
    }
    let abs = resolve_path(&file).abs;
    let text = match std::fs::read_to_string(&abs) {
        Ok(t) => t,
        Err(_) => return format!("错误：无法读取 {}（不存在或不可读）", file),
    };
    let check = apply_edit(&text, &old_string, &new_string, replace_all);
    if !check.ok {
        return check.message;
    }
    let next = if replace_all {
        text.replace(&old_string, &new_string)
    } else {
        text.replacen(&old_string, &new_string, 1)
    };
    if let Err(e) = std::fs::write(&abs, next) {
        return format!("错误：写入失败：{}", e);
    }
    let count = if replace_all { text.matches(&old_string).count() } else { 1 };
    format!("已替换 {} 中 {} 处内容", file, count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn 唯一匹配时替换成功() {
        let r = apply_edit("const a = 1;\nconst b = 2;", "const b = 2;", "const b = 3;", false);
        assert!(r.ok);
        assert_eq!(r.message, "one");
    }

    #[test]
    fn 未找到时报错并提示核对原文() {
        let r = apply_edit("hello", "world", "x", false);
        assert!(!r.ok);
        assert!(r.message.contains("未找到"), "实际：{}", r.message);
    }

    #[test]
    fn 多处出现且未开_replace_all时拒绝() {
        let r = apply_edit("x = 1; x = 2;", "x = ", "y = ", false);
        assert!(!r.ok);
        assert!(r.message.contains("2 次"), "实际：{}", r.message);
    }

    #[test]
    fn replace_all档位放行() {
        let r = apply_edit("a\nb\na", "a", "c", true);
        assert!(r.ok);
        assert_eq!(r.message, "all");
    }

    #[test]
    fn 空_old_string拒绝() {
        let r = apply_edit("abc", "", "x", false);
        assert!(!r.ok);
    }
}
