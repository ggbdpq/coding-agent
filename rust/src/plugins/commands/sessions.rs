// /sessions：列出最近会话（/resume 无编号的列表视图；加载仍用 /resume <编号>）。
use std::rc::Rc;

use super::resume::format_mtime;
use crate::kernel::app::App;
use crate::kernel::plugin::{CommandOutcome, Plugin};
use crate::kernel::ui::{dim, yellow};

pub fn sessions_plugin() -> Plugin {
    Plugin::Command(Rc::new(crate::kernel::plugin::CommandDef {
        name: "sessions",
        usage: "/sessions",
        summary: "列出最近会话（用 /resume <编号> 加载）",
        run: Rc::new(|app: &mut App, _args: &[String]| {
            let list = app.store.borrow().list_recent(5);
            if list.is_empty() {
                println!("{}", yellow("暂无历史会话。"));
                return CommandOutcome::default();
            }
            println!("最近的会话：");
            for (i, s) in list.iter().enumerate() {
                println!("  {}. {} {}", i + 1, dim(&format_mtime(s.mtime)), s.label);
            }
            CommandOutcome::default()
        }),
    }))
}
