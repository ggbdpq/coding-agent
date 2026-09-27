// /help：从注册表生成命令列表——新命令插件自动出现在帮助里。
use std::rc::Rc;

use crate::kernel::app::App;
use crate::kernel::plugin::{CommandOutcome, Plugin};

/// 生成帮助文本（独立导出便于复用）。
pub fn help_text(app: &App) -> String {
    let rows = app
        .registry
        .commands()
        .iter()
        .map(|cmd| format!("  {:<15}{}", cmd.usage, cmd.summary))
        .collect::<Vec<_>>();
    let mut lines = vec!["命令：".to_string()];
    lines.extend(rows);
    lines.push("其他输入直接作为对话发给模型。".to_string());
    lines.push("Ctrl+C：退出进程（轮中中止暂不支持，见 README 已知局限）。".to_string());
    lines.join("\n")
}

pub fn help_plugin() -> Plugin {
    Plugin::Command(Rc::new(crate::kernel::plugin::CommandDef {
        name: "help",
        usage: "/help",
        summary: "显示本帮助",
        run: Rc::new(|app: &mut App, _args: &[String]| {
            println!("{}", help_text(app));
            CommandOutcome::default()
        }),
    }))
}
