// /compact：手动触发上下文摘要压缩（自动触发见 core/turn.rs 的超限治理）。
// 失败只打印不上抛：压缩是优化手段，绝不能打断会话。
use std::rc::Rc;

use crate::core::compact::compact_context;
use crate::kernel::app::App;
use crate::kernel::plugin::{CommandOutcome, Plugin};
use crate::kernel::ui::yellow;

pub fn compact_plugin() -> Plugin {
    Plugin::Command(Rc::new(crate::kernel::plugin::CommandDef {
        name: "compact",
        usage: "/compact",
        summary: "把当前对话压缩成摘要，释放上下文预算",
        run: Rc::new(|app: &mut App, _args: &[String]| {
            match compact_context(app) {
                Ok(saved) => {
                    println!("已压缩：替换为任务摘要，节省约 {} tokens 的上下文预算。", saved);
                }
                Err(e) => {
                    println!("{}", yellow(&format!("压缩未执行：{}", e)));
                }
            }
            CommandOutcome::default()
        }),
    }))
}
