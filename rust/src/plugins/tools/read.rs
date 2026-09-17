// read 工具：带行号读文件，支持 offset/limit 分段；超大文件拒读并提示分段。
// 路径先过守卫统一解析（读操作免确认，但解析规则与写类保持一致）。
use std::rc::Rc;

use serde_json::Value;

use super::{arg_number, arg_str, pathguard::resolve_path};
use crate::kernel::plugin::{Plugin, ToolDef};

const MAX_BYTES: usize = 1024 * 1024;
const DEFAULT_LIMIT: f64 = 2000.0;

pub fn read_plugin() -> Plugin {
    Plugin::Tool(Rc::new(ToolDef {
        name: "read",
        description: "读取文件内容，带行号（1-based）。大文件可用 offset（起始行）和 limit（最多行数）分段读取。",
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "文件路径，相对当前目录或绝对路径"},
                "offset": {"type": "number", "description": "起始行号（1-based），默认 1"},
                "limit": {"type": "number", "description": "最多读取行数，默认 2000"}
            },
            "required": ["file_path"]
        }),
        needs_permission: false,
        preview: Rc::new(|args: &Value| format!("read {}", arg_str(args, "file_path"))),
        run: Rc::new(|args: &Value| run_read(args)),
    }))
}

fn run_read(args: &Value) -> String {
    let file = arg_str(args, "file_path");
    if file.is_empty() {
        return "错误：缺少 file_path".to_string();
    }
    let abs = resolve_path(&file).abs;
    let st = match std::fs::metadata(&abs) {
        Ok(s) => s,
        Err(_) => return format!("错误：文件不存在：{}", file),
    };
    if st.is_dir() {
        return format!("错误：{} 是目录，请用 glob 列文件", file);
    }
    if st.len() > MAX_BYTES as u64 {
        return format!("错误：文件过大（{} 字节，上限 {}），请用 offset/limit 分段读取", st.len(), MAX_BYTES);
    }
    let data = match std::fs::read(&abs) {
        Ok(d) => d,
        Err(e) => return format!("错误：读取失败：{}", e),
    };
    let text = String::from_utf8_lossy(&data);
    let lines: Vec<&str> = text.split('\n').collect();
    let total = lines.len();
    let offset = arg_number(args, "offset", 1.0) as i64 - 1;
    let start = offset.clamp(0, total.max(1) as i64 - 1) as usize;
    let limit = (arg_number(args, "limit", DEFAULT_LIMIT) as usize).max(1);
    let end = (start + limit).min(total);
    let body = lines[start..end]
        .iter()
        .enumerate()
        .map(|(i, l)| format!("{:>6}\t{}", start + i + 1, l))
        .collect::<Vec<_>>()
        .join("\n");
    if end < total {
        format!(
            "{}\n（已显示第 {}-{} 行，共 {} 行；继续读请调大 offset）",
            body,
            start + 1,
            end,
            total
        )
    } else {
        body
    }
}
