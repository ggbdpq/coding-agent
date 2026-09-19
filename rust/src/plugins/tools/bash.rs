// bash 工具：子进程执行命令，输出封顶、超时强杀。
// win32 优先用 Git Bash（模型常发 unix 命令），只认显式路径，避免误中 System32 的 WSL bash；
// 都没有就退回 cmd。安全边界：执行前经权限确认，确认界面展示完整命令。
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::rc::Rc;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::{arg_number, arg_str};
use crate::kernel::plugin::{Plugin, ToolDef};

const MAX_OUTPUT: usize = 64 * 1024;
const DEFAULT_TIMEOUT_SEC: f64 = 120.0;
const MAX_TIMEOUT_SEC: f64 = 600.0;

/// Windows 下隐藏子进程控制台窗口（CREATE_NO_WINDOW）。
pub(crate) fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

struct ShellCmd {
    file: String,
    args: Vec<&'static str>,
}

/// win32 优先 RCODE_BASH → Git Bash 默认路径 → cmd。
fn resolve_shell() -> ShellCmd {
    if cfg!(windows) {
        let mut candidates: Vec<String> = Vec::new();
        if let Ok(v) = std::env::var("RCODE_BASH") {
            if !v.trim().is_empty() {
                candidates.push(v);
            }
        }
        candidates.push(r"C:\Program Files\Git\bin\bash.exe".to_string());
        for b in &candidates {
            if std::path::Path::new(b).exists() {
                return ShellCmd { file: b.clone(), args: vec!["-c"] };
            }
        }
        let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        return ShellCmd { file: comspec, args: vec!["/d", "/s", "/c"] };
    }
    ShellCmd { file: "/bin/bash".to_string(), args: vec!["-c"] }
}

pub fn bash_plugin() -> Plugin {
    Plugin::Tool(Rc::new(ToolDef {
        name: "bash",
        description: "在当前目录执行 shell 命令并返回退出码与输出。用于跑测试、构建、git 等验证操作；输出超长会被截断。",
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "要执行的命令"},
                "timeout_sec": {"type": "number", "description": "超时秒数，默认 120，上限 600"}
            },
            "required": ["command"]
        }),
        needs_permission: true,
        preview: Rc::new(|args: &Value| {
            let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
            format!("执行命令（cwd={}）\n$ {}", cwd.to_string_lossy(), arg_str(args, "command"))
        }),
        run: Rc::new(|args: &Value| run_bash(args)),
        skip_permission: None,
    }))
}

fn run_bash(args: &Value) -> String {
    let command = arg_str(args, "command");
    if command.trim().is_empty() {
        return "错误：缺少 command".to_string();
    }
    let timeout_sec = arg_number(args, "timeout_sec", DEFAULT_TIMEOUT_SEC).clamp(1.0, MAX_TIMEOUT_SEC);
    let shell = resolve_shell();
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));

    let mut cmd = Command::new(&shell.file);
    cmd.args(&shell.args)
        .arg(&command)
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return format!("错误：无法启动 shell（{}）", e),
    };
    let pid = child.id();
    let out_h = spawn_reader(child.stdout.take());
    let err_h = spawn_reader(child.stderr.take());

    let deadline = Instant::now() + Duration::from_secs_f64(timeout_sec);
    let mut killed = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {
                if Instant::now() >= deadline {
                    killed = true;
                    kill_tree(pid, &mut child);
                    break child.wait().ok();
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => break None,
        }
    };
    let out = out_h.join().unwrap_or_default();
    let err = err_h.join().unwrap_or_default();

    let exit_str = if killed {
        format!("exit=timeout（{}s 超时强制终止）", timeout_sec as i64)
    } else {
        match &status {
            Some(st) => format!("exit={}", exit_code_str(st)),
            None => "exit=unknown".to_string(),
        }
    };
    let mut parts = vec![exit_str];
    if !out.trim().is_empty() {
        parts.push(format!("--- stdout ---\n{}", cap_output(&out).trim_end()));
    }
    if !err.trim().is_empty() {
        parts.push(format!("--- stderr ---\n{}", cap_output(&err).trim_end()));
    }
    parts.join("\n")
}

fn exit_code_str(st: &std::process::ExitStatus) -> String {
    match st.code() {
        Some(c) => c.to_string(),
        None => {
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                st.signal().map_or_else(|| "unknown".to_string(), |s| format!("signal:{}", s))
            }
            #[cfg(not(unix))]
            {
                "unknown".to_string()
            }
        }
    }
}

/// 超时强杀：Windows 用 taskkill 连坐整棵进程树，其他平台直接 SIGKILL。
fn kill_tree(pid: u32, child: &mut Child) {
    #[cfg(windows)]
    {
        let mut tk = Command::new("taskkill");
        tk.args(["/pid", &pid.to_string(), "/T", "/F"]);
        hide_window(&mut tk);
        let _ = tk.spawn();
        let _ = child.kill();
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
}

/// 后台线程读管道：超过上限后排干不累积（防子进程写管道阻塞）。
fn spawn_reader(r: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut s: Vec<u8> = Vec::new();
        if let Some(mut r) = r {
            let mut chunk = [0u8; 8192];
            loop {
                match r.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if s.len() < MAX_OUTPUT * 2 {
                            s.extend_from_slice(&chunk[..n]);
                        }
                    }
                }
            }
        }
        super::read_lossy_capped(&mut &s[..], MAX_OUTPUT * 2)
    })
}

fn cap_output(s: &str) -> String {
    let count = s.chars().count();
    if count < MAX_OUTPUT {
        return s.to_string();
    }
    format!("{}\n…（输出超长已截断）", s.chars().take(MAX_OUTPUT).collect::<String>())
}
