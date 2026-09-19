// /resume：恢复历史会话。无编号=列最近 5 个；编号=加载并换新会话文件继续写。
use std::path::Path;
use std::rc::Rc;

use std::time::{Duration, UNIX_EPOCH};

use crate::kernel::app::App;
use crate::kernel::plugin::{CommandOutcome, Plugin};
use crate::kernel::ui::{dim, green, yellow};

pub fn resume_plugin() -> Plugin {
    Plugin::Command(Rc::new(crate::kernel::plugin::CommandDef {
        name: "resume",
        usage: "/resume [编号]",
        summary: "恢复历史会话（无编号=列最近 5 个）",
        run: Rc::new(|app: &mut App, args: &[String]| {
            let list = app.store.borrow().list_recent(5);
            if list.is_empty() {
                println!("{}", yellow("暂无可恢复的历史会话。"));
                return CommandOutcome::default();
            }
            let n = args.first().and_then(|s| s.trim().parse::<usize>().ok());
            let valid = n.map_or(false, |n| n >= 1 && n <= list.len());
            if !valid {
                println!("最近的会话：");
                for (i, s) in list.iter().enumerate() {
                    println!("  {}. {} {}", i + 1, dim(&format_mtime(s.mtime)), s.label);
                }
                if n.is_none() {
                    println!("{}", yellow("用 /resume <编号> 加载"));
                } else {
                    println!("{}", yellow(&format!("编号无效（1-{}）", list.len())));
                }
                return CommandOutcome::default();
            }
            let picked = &list[n.unwrap() - 1];
            let loaded: Vec<_> = app
                .store
                .borrow()
                .load(&picked.file)
                .into_iter()
                .filter(|m| m.role != "system")
                .collect();
            app.reset_messages();
            app.messages.extend(loaded.iter().cloned());
            app.start_session(serde_json::json!({
                "resumedFrom": Path::new(&picked.file)
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default()
            }));
            println!("{}", green(&format!("已恢复 {} 条消息，后续写入新会话文件。", loaded.len())));
            CommandOutcome::default()
        }),
    }))
}

/// 毫秒时间戳 → "YYYY-MM-DD HH:MM:SS"（UTC；标准库不含本地时区，不引 chrono）。
pub(crate) fn format_mtime(ms: i64) -> String {
    let t = UNIX_EPOCH + Duration::from_millis(ms.max(0) as u64);
    let secs = t
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86400) as i64;
    let sod = secs % 86400;
    let (y, m, d) = civil(days);
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, m, d, sod / 3600, sod % 3600 / 60, sod % 60)
}

/// 天数 → (年, 月, 日)（civil_from_days，同 session.rs）。
fn civil(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
