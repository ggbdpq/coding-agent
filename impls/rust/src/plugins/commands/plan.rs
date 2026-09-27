// /plan：切换 Plan Mode（只读规划）。开启时写类工具在 agentloop 被拒，
// 引导模型只读探索并产出计划；关闭后恢复正常执行。
// 系统提示词的 Plan Mode 分节由本命令直接维护在 messages[0] 上。
use std::rc::Rc;

use crate::kernel::app::App;
use crate::kernel::plugin::{CommandOutcome, Plugin};
use crate::kernel::ui::{green, yellow};

/// 追加到 system 提示词的 Plan Mode 分节（以空行开头）。
const PLAN_SECTION: &str = "\n# Plan Mode（当前生效）\n当前为只读规划阶段：禁止 write/edit/bash/web_fetch 等写类操作。\n请用 read/glob/grep 只读探索，并用 todo 工具把分步计划记录下来；\n计划完成后明确告知用户：切换回普通模式（/plan）执行。";

pub fn plan_plugin() -> Plugin {
    Plugin::Command(Rc::new(crate::kernel::plugin::CommandDef {
        name: "plan",
        usage: "/plan",
        summary: "切换 Plan Mode（只读规划 ↔ 普通执行）",
        run: Rc::new(|app: &mut App, _args: &[String]| {
            let next = !app.plan_mode.get();
            app.plan_mode.set(next);
            if let Some(sys) = app.messages.first_mut() {
                if next {
                    if !sys.text().contains("# Plan Mode") {
                        let mut content = sys.text().to_string();
                        content.push_str(PLAN_SECTION);
                        sys.content = Some(content);
                    }
                } else if sys.content.is_some() {
                    let kept =
                        sys.text().split("\n# Plan Mode（当前生效）").next().unwrap_or("").to_string();
                    sys.content = Some(kept);
                }
            }
            if next {
                println!("{}", yellow("已进入 Plan Mode：只读探索与规划，写类工具将被拒绝。"));
            } else {
                println!("{}", green("已退出 Plan Mode，恢复正常执行。"));
            }
            CommandOutcome::default()
        }),
    }))
}
