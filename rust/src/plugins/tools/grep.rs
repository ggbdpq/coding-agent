// grep 工具：按正则搜文件内容（ripgrep，尊重 .gitignore）。一工具一文件。
use std::rc::Rc;

use serde_json::Value;

use super::{arg_str, rg::run_rg};
use crate::kernel::plugin::{Plugin, ToolDef};

pub fn grep_plugin() -> Plugin {
    Plugin::Tool(Rc::new(ToolDef {
        name: "grep",
        description: "按正则搜文件内容（ripgrep 语法，智能大小写），返回 行号:内容",
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "正则表达式"},
                "path": {"type": "string", "description": "限定搜索的目录或文件，默认当前目录"},
                "include": {"type": "string", "description": "文件名 glob 过滤，如 \"*.ts\""}
            },
            "required": ["pattern"]
        }),
        needs_permission: false,
        preview: Rc::new(|args: &Value| format!("grep {}", arg_str(args, "pattern"))),
        run: Rc::new(|args: &Value| {
            let pattern = arg_str(args, "pattern");
            if pattern.is_empty() {
                return "错误：缺少 pattern".to_string();
            }
            let mut rg_args = vec!["-n".to_string(), "-S".to_string()];
            let include = arg_str(args, "include");
            if !include.is_empty() {
                rg_args.push("-g".to_string());
                rg_args.push(include);
            }
            rg_args.push("--".to_string());
            rg_args.push(pattern);
            let path = arg_str(args, "path");
            rg_args.push(if path.is_empty() { ".".to_string() } else { path });
            run_rg(&rg_args, 8000)
        }),
        skip_permission: None,
    }))
}
