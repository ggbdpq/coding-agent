// glob 工具：按 glob 模式列文件（ripgrep，尊重 .gitignore）。一工具一文件。
use std::rc::Rc;

use serde_json::Value;

use super::{arg_str, rg::run_rg};
use crate::kernel::plugin::{Plugin, ToolDef};

pub fn glob_plugin() -> Plugin {
    Plugin::Tool(Rc::new(ToolDef {
        name: "glob",
        description: r#"按 glob 模式列文件（尊重 .gitignore），如 "*.ts"、"src/**/*.test.ts""#,
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "glob 模式"}
            },
            "required": ["pattern"]
        }),
        needs_permission: false,
        preview: Rc::new(|args: &Value| format!("glob {}", arg_str(args, "pattern"))),
        run: Rc::new(|args: &Value| {
            let pattern = arg_str(args, "pattern");
            if pattern.is_empty() {
                return "错误：缺少 pattern".to_string();
            }
            run_rg(&["--files".to_string(), "-g".to_string(), pattern], 8000)
        }),
        skip_permission: None,
    }))
}
