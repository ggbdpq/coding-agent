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

/// 旧文本 → 新文本的简易行级 diff 预览（前缀 +/-，保留两侧公共首尾行减少噪音）。
/// 不做 LCS 最小 diff——确认预览要的是"改了什么"而非"最短编辑脚本"；
/// 需要精确 diff 时升级为独立渲染器。
pub fn preview_diff(old_text: &str, new_text: &str, max_lines: usize) -> String {
    let old_lines: Vec<&str> = old_text.split('\n').collect();
    let new_lines: Vec<&str> = new_text.split('\n').collect();
    // 公共前缀/后缀
    let mut pre = 0;
    while pre < old_lines.len() && pre < new_lines.len() && old_lines[pre] == new_lines[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < old_lines.len() - pre
        && suf < new_lines.len() - pre
        && old_lines[old_lines.len() - 1 - suf] == new_lines[new_lines.len() - 1 - suf]
    {
        suf += 1;
    }
    let removed: Vec<String> =
        old_lines[pre..old_lines.len() - suf].iter().map(|l| format!("-{}", l)).collect();
    let added: Vec<String> =
        new_lines[pre..new_lines.len() - suf].iter().map(|l| format!("+{}", l)).collect();
    let ctx_before: Vec<String> =
        old_lines[pre.saturating_sub(2)..pre].iter().map(|l| format!(" {}", l)).collect();
    // JS 的 slice 末尾越界自动收敛，Rust 手动夹到 len
    let after_end = (new_lines.len() - suf + 2).min(new_lines.len());
    let ctx_after: Vec<String> =
        new_lines[new_lines.len() - suf..after_end].iter().map(|l| format!(" {}", l)).collect();
    let mut lines = ctx_before;
    lines.extend(removed);
    lines.extend(added);
    lines.extend(ctx_after);
    let total = lines.len();
    let body = lines.into_iter().take(max_lines).collect::<Vec<_>>().join("\n");
    if total > max_lines {
        format!("{}\n…（diff 共 {} 行，已截断）", body, total)
    } else {
        body
    }
}

#[cfg(test)]
mod tests {
    // preview_diff 单测（镜像 tcode/test/diff.test.ts 三例）：前缀 +/-、公共上下文收敛。
    use super::*;

    #[test]
    fn 相同文本无加减号行() {
        let d = preview_diff("a\nb", "a\nb", 40);
        assert!(!d.contains("-a") && !d.contains("+a"));
    }

    #[test]
    fn 替换显示减旧行与加新行() {
        let d = preview_diff("old line", "new line", 40);
        assert!(d.contains("-old line"));
        assert!(d.contains("+new line"));
    }

    #[test]
    fn 多行修改保留上下文顺序() {
        let d = preview_diff("a\nb\nc", "a\nB\nc", 40);
        assert!(d.contains(" a") && d.contains(" c"), "公共行保留：{}", d);
        assert!(d.contains("-b") && d.contains("+B"));
    }
}
