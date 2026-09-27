// /yolo：切换本会话免确认模式（与 --yolo 启动参数、权限确认里的 a 改的是同一个开关）。
use std::rc::Rc;

use crate::kernel::app::App;
use crate::kernel::plugin::{CommandOutcome, Plugin};
use crate::kernel::ui::{green, yellow};

pub fn yolo_plugin() -> Plugin {
    Plugin::Command(Rc::new(crate::kernel::plugin::CommandDef {
        name: "yolo",
        usage: "/yolo",
        summary: "切换本会话免确认模式",
        run: Rc::new(|app: &mut App, _args: &[String]| {
            let next = !app.yolo.get();
            app.yolo.set(next);
            if next {
                println!("{}", yellow("已开启免确认（yolo）。"));
            } else {
                println!("{}", green("已恢复逐次确认。"));
            }
            CommandOutcome::default()
        }),
    }))
}
