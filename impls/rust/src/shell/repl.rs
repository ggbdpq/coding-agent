// REPL 壳插件：读入 → 命令查表分发 → runUserTurn → 渲染事件。命令本体都是插件，壳只管路由。
// v1 取舍：轮中 Ctrl+C 直接退出进程（SIGINT 默认行为），不做轮中中止——见 README 已知局限。
use std::cell::Cell;
use std::io::Write;
use std::rc::Rc;

use crate::core::permission::{
    create_permission_gate, PermissionDecision, PermissionIO, PermissionRequest,
};
use crate::core::turn::{run_user_turn, TurnHooks};
use crate::kernel::app::App;
use crate::kernel::plugin::{Plugin, ShellDef};
use crate::kernel::types::AgentEvent;
use crate::kernel::ui::{bold, cyan, dim, ellipsis, red, yellow};

/// 权限 UI 适配：打印预览 + 问 y/n/a；stdin 关闭视作拒绝。
struct ReplAsk;

impl PermissionIO for ReplAsk {
    fn ask(&self, req: PermissionRequest) -> PermissionDecision {
        println!("\n{}{}", yellow(&format!("── {} 请求执行 ──", req.tool)), "");
        println!("{}", dim(&req.preview));
        loop {
            print!("{}", bold("允许? [y=允许 / n=拒绝 / a=本会话全部允许] "));
            let _ = std::io::stdout().flush();
            let mut ans = String::new();
            if std::io::stdin().read_line(&mut ans).unwrap_or(0) == 0 {
                return PermissionDecision::Deny;
            }
            match ans.trim().to_lowercase().as_str() {
                "y" => return PermissionDecision::Allow,
                "a" => {
                    println!("{}", yellow("本会话后续操作不再逐次确认（可用 /yolo 切回）。"));
                    return PermissionDecision::Always;
                }
                "n" | "" => return PermissionDecision::Deny,
                _ => println!("{}", dim("请回答 y / n / a")),
            }
        }
    }
}

fn start_repl(app: &mut App) -> Result<(), String> {
    let gate = create_permission_gate(Rc::new(ReplAsk), app.yolo.clone());

    // 横幅：版本/模型/cwd/yolo
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let mut banner = vec![format!(
        "{} v{} {}",
        bold("rcode"),
        crate::kernel::app::VERSION,
        dim(&format!("· {} · {}", app.config.model, cwd.to_string_lossy()))
    )];
    if app.yolo.get() {
        banner.push(yellow("当前 --yolo：所有操作免确认"));
    }
    banner.push(dim("输入 /help 查看命令，/exit 退出"));
    println!("{}", banner.join("\n"));

    loop {
        print!("{}", cyan("rcode❯ "));
        let _ = std::io::stdout().flush();
        let mut line = String::new();
        if std::io::stdin().read_line(&mut line).unwrap_or(0) == 0 {
            break; // stdin 关闭
        }
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        if let Some(rest) = line.strip_prefix('/') {
            let mut parts = rest.split_whitespace();
            let name = parts.next().unwrap_or("");
            let args: Vec<String> = parts.map(str::to_string).collect();
            // 先把命令 Rc 拿出来（结束对 registry 的借用），再以 &mut App 调用
            let cmd = app.registry.commands().into_iter().find(|c| c.name == name);
            match cmd {
                Some(cmd) => {
                    let outcome = (cmd.run)(app, &args);
                    if outcome.exit {
                        break;
                    }
                }
                None => println!("{}", yellow(&format!("未知命令 /{}，/help 查看可用命令。", name))),
            }
            continue;
        }

        // 事件渲染：壳只订阅 AgentEvent，不拼装（text_delta 直写；其余同既有输出，零行为变化）
        let mut render = |ev: AgentEvent| match ev {
            AgentEvent::TextDelta { delta } => {
                print!("{}", delta);
                let _ = std::io::stdout().flush();
            }
            AgentEvent::ToolCall { name, args, .. } => {
                println!("\n{} {}", cyan(&format!("⚙ {}", name)), dim(&ellipsis(&args.to_string(), 120)));
            }
            AgentEvent::ToolResult { summary, ms, .. } => {
                println!("{}", dim(&format!("  ↳ {} ({}ms)", ellipsis(&summary, 100), ms)));
            }
            AgentEvent::Trimmed { count } => {
                println!("{}", dim(&format!("（上下文超预算，已省略 {} 条早期工具输出）", count)));
            }
            AgentEvent::Compact { saved_tokens } => {
                println!(
                    "{}",
                    dim(&format!("（上下文超预算，已压缩为任务摘要，节省约 {} tokens）", saved_tokens))
                );
            }
            _ => {}
        };
        let hooks = TurnHooks { check: Some(gate.clone()) };
        match run_user_turn(app, &line, &hooks, &mut render) {
            Ok(()) => println!(),
            Err(e) => println!("{}", red(&format!("出错了：{}", e))),
        }
    }
    Ok(())
}

/// REPL 壳插件。
pub fn repl_plugin() -> Plugin {
    Plugin::Shell(Rc::new(ShellDef { name: "repl", start: Rc::new(start_repl) }))
}

/// 供编译器确认 Cell 在本模块的使用面（yolo 开关经 App 持有）。
#[allow(dead_code)]
fn touch_cell(c: &Cell<bool>) -> bool {
    c.get()
}
