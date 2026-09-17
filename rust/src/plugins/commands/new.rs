// /new：开新会话——messages 换新 system 数组并换新会话文件。
use std::rc::Rc;

use serde_json::Value;

use crate::kernel::app::App;
use crate::kernel::plugin::{CommandOutcome, Plugin};
use crate::kernel::ui::green;

pub fn new_plugin() -> Plugin {
    Plugin::Command(Rc::new(crate::kernel::plugin::CommandDef {
        name: "new",
        usage: "/new",
        summary: "开新会话（清空上下文）",
        run: Rc::new(|app: &mut App, _args: &[String]| {
            app.reset_messages();
            app.start_session(Value::Null);
            println!("{}", green("已开新会话，上下文已清空。"));
            CommandOutcome::default()
        }),
    }))
}
