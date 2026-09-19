// 系统提示词：rcode 身份 + 运行环境 + 指令文件注入 + 技能索引。
// 注入顺序：~/.rcode/AGENTS.md（全局）在前，项目根 AGENTS.md 在后（后者更具体）。
// Skill 约定：~/.rcode/skills/*.md 与 <cwd>/.rcode/skills/*.md 为技能库，
// 此处只注入"可用技能索引"，正文由 agent 按需用 read 工具读取——最小机制，无加载器。
use std::path::{Path, PathBuf};

use super::session::today_utc;
use crate::kernel::config::home_dir;

fn read_if_exists(file: &Path) -> Option<String> {
    std::fs::read_to_string(file).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// 技能索引：列出技能目录中每个 .md 的名字与首行说明（无任何条目返回 None）。
pub fn skill_index(dirs: &[PathBuf]) -> Option<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in dirs {
        // 不存在/不可解析的目录跳过；canonicalize 顺带归一，边界自检基于同一形状
        let dir = match std::fs::canonicalize(raw) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let dir_str = dir.to_string_lossy().to_string();
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".md") {
                continue;
            }
            let full = dir.join(&name);
            // 边界自检（规范惯用法）：文件必须位于技能目录之内
            if !full.to_string_lossy().starts_with(&format!("{}{}", dir_str, std::path::MAIN_SEPARATOR))
            {
                continue;
            }
            let desc = std::fs::read_to_string(&full)
                .ok()
                .and_then(|text| text.split('\n').find(|l| !l.trim().is_empty()).map(str::to_string))
                .map(|first| {
                    // 去前导 #（含紧随空白），按 char 截 60 字符保中文不碎
                    let stripped = first.trim_start_matches('#');
                    let desc =
                        if stripped.len() < first.len() { stripped.trim_start() } else { first.as_str() };
                    desc.chars().take(60).collect::<String>()
                })
                .unwrap_or_default();
            let base = dir.file_name().map(|b| b.to_string_lossy().to_string()).unwrap_or_default();
            lines.push(format!("- {}/{}：{}（用 read 工具按需读取全文）", base, name, desc));
        }
    }
    if lines.is_empty() {
        return None;
    }
    let mut out = vec!["## 可用技能（按需用 read 读取全文）".to_string()];
    out.extend(lines);
    Some(out.join("\n"))
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
        "- 跨文件多处一致的修改用 apply_patch 原子补丁（先全部预验再写入）。".to_string(),
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
    // Skill 索引：~/.rcode/skills 与 <cwd>/.rcode/skills（与全局/项目指令同约定）
    let mut skill_dirs: Vec<PathBuf> = Vec::new();
    if let Some(home) = home_dir() {
        skill_dirs.push(home.join(".rcode").join("skills"));
    }
    skill_dirs.push(Path::new(cwd).join(".rcode").join("skills"));
    if let Some(skills) = skill_index(&skill_dirs) {
        parts.push(String::new());
        parts.push(skills);
    }
    parts.join("\n")
}
