// 内置插件清单：加插件 = 加文件 + 在这里挂一行。
// 显式组合而非目录扫描——装配顺序可读、可预测。
// 注意 openai provider 必须排在 provider 类的最后（matches 恒真，是兜底）。
pub mod commands;
pub mod tools;

use crate::kernel::plugin::Plugin;
use crate::providers;
use crate::shell;

/// 返回全部内置插件（顺序即装配优先级）。
pub fn builtin_plugins() -> Vec<Plugin> {
    vec![
        // —— 工具 ——
        tools::read::read_plugin(),
        tools::write::write_plugin(),
        tools::edit::edit_plugin(),
        tools::bash::bash_plugin(),
        tools::glob::glob_plugin(),
        tools::grep::grep_plugin(),
        tools::todo::todo_plugin(),
        tools::webfetch::webfetch_plugin(),
        // —— 命令（/help 列表按这里的顺序展示） ——
        commands::help::help_plugin(),
        commands::new::new_plugin(),
        commands::resume::resume_plugin(),
        commands::yolo::yolo_plugin(),
        commands::exit::exit_plugin(),
        // —— 协议（anthropic 在前按 URL 命中，openai 恒真兜底必须在后） ——
        providers::anthropic::anthropic_plugin(),
        providers::openai::openai_plugin(),
        // —— 壳 ——
        shell::repl::repl_plugin(),
    ]
}
