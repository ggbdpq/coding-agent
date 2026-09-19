// 入口：装配——注册内置插件 → 创建 App → 起 shell（repl）或无交互 exec。
// 缺配置给中文指路，不甩堆栈。
mod core;
mod kernel;
mod plugins;
mod providers;
mod shell;

use std::cell::RefCell;
use std::io::Write as _;
use std::path::PathBuf;
use std::rc::Rc;

use core::atrefs::{expand_at_refs, read_capped};
use core::session::SessionStore;
use core::systemprompt::build_system_prompt;
use core::turn::{run_user_turn, TurnHooks};
use kernel::app::{create_app, App, AppOptions};
use kernel::config::load_config;
use kernel::plugin::Registry;
use kernel::types::{AgentEvent, ChatMessage, TurnEndReason};
use kernel::ui::ellipsis;

const USAGE: &str = "rcode —— 极简本地优先 coding agent

用法：rcode [exec \"任务\"] [--continue] [--yolo] [--help] [--version]

  exec \"任务\"  无交互执行单个任务后退出（CI/脚本用；必须配合 --yolo）
  --continue   启动时恢复最近一次会话
  --yolo       跳过写文件/执行命令的逐次确认（会话内可用 /yolo 切换）
  --help       显示本帮助
  --version    显示版本

环境变量：RCODE_API_KEY / RCODE_BASE_URL / RCODE_MODEL / RCODE_PROTOCOL / RCODE_APPROVAL
          （或写 ~/.rcode/config.json）";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("{}", USAGE);
        return;
    }
    if args.iter().any(|a| a == "--version") {
        println!("rcode v{}", kernel::app::VERSION);
        return;
    }
    let yolo = args.iter().any(|a| a == "--yolo");
    let cont = args.iter().any(|a| a == "--continue");
    // 位置参数：首个 exec 切到无交互壳，其余为任务描述；repl 不吃位置参数
    let extra: Vec<String> = args.iter().filter(|a| !a.starts_with("--")).cloned().collect();
    let (shell_name, rest) = match extra.first() {
        Some(s) if s == "exec" => ("exec", extra[1..].to_vec()),
        _ => {
            if !extra.is_empty() {
                println!("提示：忽略多余参数：{}", extra.join(" "));
            }
            ("repl", Vec::new())
        }
    };

    if let Err(e) = run(shell_name, &rest, yolo, cont) {
        eprintln!("启动失败：{}", e);
        std::process::exit(1);
    }
}

fn run(shell_name: &str, rest: &[String], yolo: bool, cont: bool) -> Result<(), String> {
    let config = load_config()?;
    // 审批策略 never 与 --yolo 等价（R4）
    let yolo = yolo || config.approval.as_deref() == Some("never");
    let mut registry = Registry::new();
    registry.register_all(plugins::builtin_plugins())?;
    let store = Rc::new(RefCell::new(SessionStore::new(&config.rcode_dir.join("sessions"))?));
    let mut app = create_app(
        config,
        registry,
        AppOptions {
            yolo,
            fresh_messages: Box::new(|| {
                let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
                vec![ChatMessage::system(build_system_prompt(&cwd.to_string_lossy()))]
            }),
            store,
        },
    )?;

    if cont {
        resume_latest(&mut app);
    }

    if shell_name == "exec" {
        run_exec(&mut app, rest); // 出错自行以退出码 1 收尾
        return Ok(());
    }
    let shell = app
        .registry
        .shell(shell_name)
        .ok_or_else(|| format!("找不到 shell 插件：{}", shell_name))?;
    (shell.start)(&mut app)
}

/// --continue（v0.4-3 会话 picker）：加载最近会话的全部非 system 消息并入当前会话，
/// 换新会话文件继续写（与 /resume 1 同语义，少一次交互）。
fn resume_latest(app: &mut App) {
    let latest = app.store.borrow().list_recent(1).into_iter().next();
    let Some(entry) = latest else {
        println!("没有可恢复的会话，从新会话开始。");
        return;
    };
    let loaded: Vec<ChatMessage> = app
        .store
        .borrow()
        .load(&entry.file)
        .into_iter()
        .filter(|m| m.role != "system")
        .collect();
    app.messages.extend(loaded.iter().cloned());
    let name = std::path::Path::new(&entry.file)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    app.start_session(serde_json::json!({ "resumedFrom": name }));
    println!("已恢复最近会话（{} 条消息）。", loaded.len());
}

/// exec 无交互模式（v0.4-2）：事件渲染为纯文本行，完成退出码 0、出错 1。
/// exec 已强制 --yolo，无需交互闸门；@引用展开与 REPL 共用同一份实现。
fn run_exec(app: &mut App, rest: &[String]) {
    if !app.yolo.get() {
        eprintln!("错误：exec 模式必须配合 --yolo（无交互环境无法逐次确认写操作）");
        std::process::exit(1);
    }
    let task = expand_at_refs(&rest.join(" "), &read_capped);
    let task = task.trim();
    if task.is_empty() {
        eprintln!("错误：exec 需要任务描述：rcode exec \"任务\"");
        std::process::exit(1);
    }
    let mut failed = false;
    let hooks = TurnHooks { check: None };
    let result = run_user_turn(app, task, &hooks, &mut |ev: AgentEvent| match ev {
        AgentEvent::TextDelta { delta } => {
            print!("{}", delta);
        }
        AgentEvent::ToolCall { name, args, .. } => {
            println!("\n[tool] {} {}", name, ellipsis(&args.to_string(), 160));
        }
        AgentEvent::ToolResult { summary, ms, .. } => {
            println!("[result] {} ({}ms)", summary, ms);
        }
        AgentEvent::TurnEnd { reason, error } => {
            if reason != TurnEndReason::Completed {
                let reason_text = match reason {
                    TurnEndReason::Completed => "completed",
                    TurnEndReason::Aborted => "aborted",
                    TurnEndReason::Error => "error",
                };
                eprintln!("\n[turn:{}]{}", reason_text, error.unwrap_or_default());
                failed = true;
            }
        }
        // compact/trimmed/usage/permission 等事件：exec 渲染器忽略，仅事件流可观测
        _ => {}
    });
    match result {
        Ok(()) => {
            let _ = std::io::stdout().flush();
            println!();
        }
        Err(e) => {
            let _ = std::io::stdout().flush();
            eprintln!("错误：{}", e);
            failed = true;
        }
    }
    if failed {
        std::process::exit(1);
    }
}
