// rg 工具函数：glob/grep 两个工具共用。约定退出码：0 有匹配、1 无匹配、≥2 出错。
use std::process::{Command, Stdio};

use super::read_lossy_capped;

/// 执行 ripgrep 并按约定整理输出（cap 为结果字符封顶）。
pub fn run_rg(rg_args: &[String], cap: usize) -> String {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let mut cmd = Command::new("rg");
    cmd.args(rg_args).current_dir(&cwd).stdout(Stdio::piped()).stderr(Stdio::piped());
    crate::plugins::tools::bash::hide_window(&mut cmd);

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return format!("错误：无法启动 rg（{}）。本工具依赖 ripgrep，请先安装。", e);
        }
    };
    let output = match child.wait_with_output() {
        Ok(o) => o,
        Err(e) => return format!("错误：rg 执行失败：{}", e),
    };
    // Windows 退出码是 i32；被信号杀掉（unix）没有 code，按出错处理
    let code = output.status.code().unwrap_or(2);
    let stderr = read_lossy_capped(&mut &output.stderr[..], 8192);
    if code == 1 && stderr.trim().is_empty() {
        return "无匹配".to_string();
    }
    if code > 1 {
        let brief: String = stderr.trim().chars().take(500).collect();
        return format!("错误：rg 退出码 {}：{}", code, brief);
    }
    let mut out = read_lossy_capped(&mut &output.stdout[..], cap + 8192);
    if out.chars().count() > cap {
        out = format!("{}\n…（结果超长已截断）", out.chars().take(cap).collect::<String>());
    }
    let out = out.trim_end().to_string();
    if out.is_empty() {
        "无匹配".to_string()
    } else {
        out
    }
}
