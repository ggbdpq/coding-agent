// 入口：装配——注册内置插件 → 创建 App → 起 shell。缺配置给中文指路，不甩堆栈。
mod core;
mod kernel;
mod plugins;
mod providers;
mod shell;

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

use core::session::SessionStore;
use core::systemprompt::build_system_prompt;
use kernel::app::{create_app, AppOptions};
use kernel::config::load_config;
use kernel::plugin::Registry;
use kernel::types::ChatMessage;

const USAGE: &str = "rcode —— 极简本地优先 coding agent

用法：rcode [--yolo] [--help] [--version]

  --yolo     跳过写文件/执行命令的逐次确认（会话内可用 /yolo 切换）
  --help     显示本帮助
  --version  显示版本

环境变量：RCODE_API_KEY / RCODE_BASE_URL / RCODE_MODEL / RCODE_PROTOCOL（或写 ~/.rcode/config.json）";

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
    let extra: Vec<String> = args.iter().filter(|a| !a.starts_with("--")).cloned().collect();
    if !extra.is_empty() {
        println!("提示：rcode 目前只支持交互式使用，忽略多余参数：{}", extra.join(" "));
    }

    if let Err(e) = run(yolo) {
        eprintln!("启动失败：{}", e);
        std::process::exit(1);
    }
}

fn run(yolo: bool) -> Result<(), String> {
    let config = load_config()?;
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
    let shell = app
        .registry
        .shell("repl")
        .ok_or_else(|| "找不到 shell 插件：repl".to_string())?;
    (shell.start)(&mut app)
}
