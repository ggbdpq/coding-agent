// /exit：返回 exit 信号，由壳（repl）负责收尾退出。
use std::rc::Rc;

use crate::kernel::app::App;
use crate::kernel::plugin::{CommandOutcome, Plugin};

pub fn exit_plugin() -> Plugin {
    Plugin::Command(Rc::new(crate::kernel::plugin::CommandDef {
        name: "exit",
        usage: "/exit",
        summary: "退出（Ctrl+C 亦可）",
        run: Rc::new(|_app: &mut App, _args: &[String]| CommandOutcome { exit: true }),
    }))
}
