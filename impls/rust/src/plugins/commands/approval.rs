// /approval：查看或切换审批策略（R4）。normal=写类逐次确认；never=全部免确认。
// 运行时改的就是同一份 Config，并把 yolo 开关同步到同义状态（never≡开、normal≡关）——
// 闸门只认 yolo，不同步的话 /approval never 会"假生效"。
use std::rc::Rc;

use crate::kernel::app::App;
use crate::kernel::plugin::{CommandOutcome, Plugin};
use crate::kernel::ui::yellow;

pub fn approval_plugin() -> Plugin {
    Plugin::Command(Rc::new(crate::kernel::plugin::CommandDef {
        name: "approval",
        usage: "/approval [normal|never]",
        summary: "查看或设置审批策略（normal=写类逐次确认，never=全部免确认）",
        run: Rc::new(|app: &mut App, args: &[String]| {
            let arg = args.join(" ").trim().to_lowercase();
            if arg.is_empty() {
                let current = app.config.approval.clone().unwrap_or_else(|| "normal".into());
                let hint =
                    if current == "never" { "（全部免确认，等价 --yolo）" } else { "（写类操作逐次确认）" };
                println!("当前审批策略：{}{}", current, hint);
                return CommandOutcome::default();
            }
            match arg.as_str() {
                "normal" => {
                    app.config.approval = None;
                    app.yolo.set(false);
                    println!("审批策略已设为 normal。");
                }
                "never" => {
                    app.config.approval = Some("never".into());
                    app.yolo.set(true);
                    println!("审批策略已设为 never。");
                }
                _ => println!("{}", yellow("审批策略只能是 normal 或 never，未修改。")),
            }
            CommandOutcome::default()
        }),
    }))
}

#[cfg(test)]
mod tests {
    // /approval 状态机单测：切换改的是同一份 Config，且必须同步 yolo 开关——
    // 闸门只认 yolo，不同步的话 /approval never 是"假生效"。
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::rc::Rc;

    use serde_json::Value;

    use super::*;
    use crate::kernel::app::{create_app, App, AppOptions, SessionStoreLike, SessionSummary};
    use crate::kernel::config::Config;
    use crate::kernel::plugin::{Plugin, ProviderDef, Registry};
    use crate::kernel::types::{ChatClient, ChatMessage, ChatOptions, CompletionResult};

    struct NoopStore;

    impl SessionStoreLike for NoopStore {
        fn start(&mut self, _meta: Value) {}
        fn append(&mut self, _message: &ChatMessage) {}
        fn list_recent(&self, _n: usize) -> Vec<SessionSummary> {
            vec![]
        }
        fn load(&self, _file: &str) -> Vec<ChatMessage> {
            vec![]
        }
    }

    struct NoProvider;

    impl ChatClient for NoProvider {
        fn chat(&self, _messages: &[ChatMessage], _opts: &ChatOptions) -> Result<CompletionResult, crate::kernel::types::ChatError> {
            Ok(CompletionResult { message: ChatMessage::assistant(None, vec![]) })
        }
    }

    fn fake_app() -> App {
        let mut registry = Registry::new();
        registry
            .register(Plugin::Provider(Rc::new(ProviderDef {
                name: "fake",
                matches: Rc::new(|_base_url: &str| true),
                create: Rc::new(|_config| Rc::new(NoProvider) as Rc<dyn ChatClient>),
            })))
            .unwrap();
        create_app(
            Config {
                api_key: "k".into(),
                base_url: "http://127.0.0.1".into(),
                model: "fake".into(),
                protocol: None,
                approval: None,
                allow_write_dirs: vec![],
                context_limit: 1_000_000,
                rcode_dir: PathBuf::from("/tmp"),
            },
            registry,
            AppOptions { yolo: false, fresh_messages: Box::new(Vec::new), store: Rc::new(RefCell::new(NoopStore)) },
        )
        .unwrap()
    }

    fn run_approval(app: &mut App, args: &[&str]) {
        let plugin = approval_plugin();
        let Plugin::Command(cmd) = plugin else { panic!("approval 应是命令插件") };
        let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        (cmd.run)(app, &owned);
    }

    #[test]
    fn 无参数_查看不改状态() {
        let mut app = fake_app();
        run_approval(&mut app, &[]);
        assert_eq!(app.config.approval, None, "查看不应改审批策略");
        assert!(!app.yolo.get());
    }

    #[test]
    fn 切换never_同步开启yolo() {
        let mut app = fake_app();
        run_approval(&mut app, &["never"]);
        assert_eq!(app.config.approval.as_deref(), Some("never"));
        assert!(app.yolo.get(), "never 必须同步 yolo，否则闸门假生效");
    }

    #[test]
    fn 切回normal_同步关闭yolo() {
        let mut app = fake_app();
        run_approval(&mut app, &["never"]);
        run_approval(&mut app, &["normal"]);
        assert_eq!(app.config.approval, None);
        assert!(!app.yolo.get());
    }

    #[test]
    fn 非法值_拒绝且不改状态() {
        let mut app = fake_app();
        run_approval(&mut app, &["bogus"]);
        assert_eq!(app.config.approval, None);
        assert!(!app.yolo.get());
    }
}
