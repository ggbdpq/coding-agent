// 终端着色与截断：零依赖 ANSI，仅在 TTY 上着色（重定向/冒烟测试输出保持干净）。
// 放 kernel：core 与 plugins 两层都要用，属共享工具。
use std::io::IsTerminal;

fn tty() -> bool {
    std::io::stdout().is_terminal()
}

fn paint(code: &str, s: &str) -> String {
    if tty() {
        format!("\x1b[{}m{}\x1b[0m", code, s)
    } else {
        s.to_string()
    }
}

/// 语义色：Dim 次要信息、Cyan 提示符/工具名、Green 成功、Yellow 警示、Red 错误、Bold 强调。
pub fn dim(s: &str) -> String {
    paint("2", s)
}

pub fn cyan(s: &str) -> String {
    paint("36", s)
}

pub fn green(s: &str) -> String {
    paint("32", s)
}

pub fn yellow(s: &str) -> String {
    paint("33", s)
}

pub fn red(s: &str) -> String {
    paint("31", s)
}

pub fn bold(s: &str) -> String {
    paint("1", s)
}

/// 超长文本截断，末尾标注省略了多少字符。
pub fn ellipsis(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    format!(
        "{}\n…（已截断，省略 {} 字符）",
        s.chars().take(max).collect::<String>(),
        count - max
    )
}
