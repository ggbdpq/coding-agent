// 系统提示词：rcode 身份 + 运行环境 + 指令文件注入。
// 注入顺序：~/.rcode/AGENTS.md（全局）在前，项目根 AGENTS.md 在后（后者更具体）。
use std::path::Path;

use super::session::today_utc;
use crate::kernel::config::home_dir;

fn read_if_exists(file: &Path) -> Option<String> {
    std::fs::read_to_string(file).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// 拼装 system 提示词。
pub fn build_system_prompt(cwd: &str) -> String {
    let mut parts: Vec<String> = vec![
        "你是 rcode，一个直接运行在用户本地终端的极简 coding agent。".to_string(),
        format!("当前工作目录：{}", cwd),
        format!("操作系统：{}；今天日期：{}", std::env::consts::OS, today_utc()),
        String::new(),
        "工作原则：".to_string(),
        "- 动手改代码前先 read 相关文件，弄清上下文再动手。".to_string(),
        "- 修改文件用 edit 做精确替换，old_string 必须带足够上下文保证唯一；新文件才用 write。".to_string(),
        "- 修改后用 bash 运行相关测试或命令验证，如实报告结果，绝不谎报通过。".to_string(),
        "- 找不到文件时先用 glob/grep 定位，不要瞎猜路径。".to_string(),
        "- 回答用简体中文，简洁直接。".to_string(),
    ];
    if let Some(home) = home_dir() {
        if let Some(global) = read_if_exists(&home.join(".rcode").join("AGENTS.md")) {
            parts.push(String::new());
            parts.push("# 用户全局指令（~/.rcode/AGENTS.md）".to_string());
            parts.push(global);
        }
    }
    if let Some(project) = read_if_exists(&Path::new(cwd).join("AGENTS.md")) {
        parts.push(String::new());
        parts.push("# 项目指令（AGENTS.md）".to_string());
        parts.push(project);
    }
    parts.join("\n")
}
