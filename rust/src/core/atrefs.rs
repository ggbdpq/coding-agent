// @文件引用（v0.4-2）：把输入里的 @path 注入对应文件内容。
// expand_at_refs 是纯函数（读文件经参数注入，方便单测）；只读不写，无需权限闸门。
// 路径含空格不支持（@token 以空白分隔）；@目录 不展开——需要时升级。
// 手写扫描代替正则：依赖政策不引 regex crate，语义对齐 tcode 的 /(^|\s)@([^\s@]+)/g。
use std::io::Read;

/// 单个 @引用 注入内容的字符上限（256KB）。
pub const MAX_ATREF_CHARS: usize = 256 * 1024;
/// 生产读文件的字节上限（1MB 内全读，超出截断）。
const MAX_READ_BYTES: u64 = 1024 * 1024;

/// 把 line 里的 @path 替换为文件内容块；读不到的 token 原样保留并标注
/// "（文件不存在）"，超长内容截断。REPL 与 exec 共用。
pub fn expand_at_refs(line: &str, read_file: &dyn Fn(&str) -> Option<String>) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::new();
    let mut i = 0usize;
    while i < chars.len() {
        // @token 的合法起点：行首或空白之后（对齐正则的 (^|\s) 前导组）
        let is_ref_start = chars[i] == '@' && (i == 0 || chars[i - 1].is_whitespace());
        if !is_ref_start {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        // 收集 token：不含空白与 @（对齐 [^\s@]+）；空 token 的孤立 @ 原样保留
        let start = i + 1;
        let mut end = start;
        while end < chars.len() && !chars[end].is_whitespace() && chars[end] != '@' {
            end += 1;
        }
        if end == start {
            out.push('@');
            i += 1;
            continue;
        }
        let raw_path: String = chars[start..end].iter().collect();
        match read_file(&raw_path) {
            None => {
                out.push('@');
                out.push_str(&raw_path);
                out.push_str("（文件不存在）");
            }
            Some(content) => {
                out.push_str(&format!("[引用文件 {}]\n", raw_path));
                let total = content.chars().count();
                if total > MAX_ATREF_CHARS {
                    // 按 char 计截断（tcode 按 UTF-16 码元）：ASCII 场景数值一致，CJK 不劈半字
                    out.extend(content.chars().take(MAX_ATREF_CHARS));
                    out.push_str(&format!("\n…（已截断，原文 {} 字符）", total));
                } else {
                    out.push_str(&content);
                }
                out.push_str("\n[/引用文件]");
            }
        }
        i = end;
    }
    out
}

/// 生产环境的 @引用 读文件：目录/不可读返回 None；内容封顶 1MB。
pub fn read_capped(path: &str) -> Option<String> {
    if std::fs::metadata(path).ok()?.is_dir() {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    file.take(MAX_READ_BYTES).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).to_string())
}

#[cfg(test)]
mod tests {
    // @文件引用纯函数单测（镜像 tcode/test/atrefs.test.ts 的三类断言）：
    // 缺失标注 / 多引用注入 / 256KB 截断。
    use std::collections::HashMap;

    use super::*;

    fn reader(files: HashMap<&'static str, String>) -> impl Fn(&str) -> Option<String> {
        move |p: &str| files.get(p).map(|s| s.clone())
    }

    #[test]
    fn 缺失文件_原token保留并标注() {
        let out = expand_at_refs("看看 @不存在.txt 说明", &|_p| None);
        assert!(out.contains("@不存在.txt（文件不存在）"), "实际：{}", out);
        assert!(!out.contains("[引用文件"), "缺失文件不应注入内容块：{}", out);
    }

    #[test]
    fn 多引用_分别注入内容块() {
        let mut files = HashMap::new();
        files.insert("a.txt", "A内容".to_string());
        files.insert("b.txt", "B内容".to_string());
        let read = reader(files);
        let out = expand_at_refs("读 @a.txt 和 @b.txt", &read);
        assert!(out.contains("[引用文件 a.txt]\nA内容\n[/引用文件]"), "实际：{}", out);
        assert!(out.contains("[引用文件 b.txt]\nB内容\n[/引用文件]"), "实际：{}", out);
        assert!(out.starts_with("读 "), "前导文本保留：{}", out);
    }

    #[test]
    fn 超长内容_256KB截断并标注() {
        let big = "あ".repeat(MAX_ATREF_CHARS + 3);
        let mut files = HashMap::new();
        files.insert("big.txt", big);
        let read = reader(files);
        let out = expand_at_refs("看 @big.txt", &read);
        assert!(out.contains("已截断"), "输出应含截断标注");
        assert!(out.contains(&format!("原文 {} 字符", MAX_ATREF_CHARS + 3)));
        assert!(out.ends_with("[/引用文件]"));
        assert_eq!(
            out.chars().filter(|c| *c == 'あ').count(),
            MAX_ATREF_CHARS,
            "截断后正文只保留 MAX_ATREF_CHARS 个字符"
        );
    }

    #[test]
    fn 无引用与孤立at_原样返回() {
        let out = expand_at_refs("普通句子 @@x @ 结尾", &|_p| Some("内容".to_string()));
        assert_eq!(out, "普通句子 @@x @ 结尾", "无有效引用时不动原文");
    }
}
