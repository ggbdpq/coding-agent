// web_fetch 工具：抓取公网页面文本，供模型查文档/API 说明。
// 安全三道闸（实现即验收条件）：仅 http/https；字面与 DNS 双重拒绝私有/保留地址；
// 重定向不自动跟随——每跳重新过守卫，杜绝"公网 302 跳内网"。
// 手动重定向的每一跳都复检 URL 字面 + DNS，这才要求 ureq 关自动重定向。
use std::io::Read;
use std::rc::Rc;
use std::time::Duration;

use serde_json::Value;

use super::netguard::{assert_resolves_public, check_url_literal, join_redirect, parse_url, ParsedUrl};
use super::{arg_number, arg_str};
use crate::kernel::plugin::{Plugin, ToolDef};

const MAX_BYTES: usize = 512 * 1024;
const DEFAULT_MAX_CHARS: f64 = 8000.0;
const MAX_REDIRECTS: usize = 5;
const TIMEOUT_SECS: u64 = 20;

/// web_fetch 专用 agent：关自动重定向（逐跳手动复检）+ 20s 整体超时。
fn fetch_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .redirects(0)
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .build()
}

pub fn webfetch_plugin() -> Plugin {
    Plugin::Tool(Rc::new(ToolDef {
        name: "web_fetch",
        description: "抓取一个公网 URL 的页面文本（仅 http/https）。用于查阅文档、API 说明、报错线索；内网/私有地址会被拒绝。",
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "完整的 http(s) URL"},
                "max_chars": {"type": "number", "description": "返回正文最大字符数，默认 8000"}
            },
            "required": ["url"]
        }),
        needs_permission: true,
        preview: Rc::new(|args: &Value| format!("GET {}（出站网络请求）", arg_str(args, "url"))),
        run: Rc::new(|args: &Value| run_web_fetch(args)),
        skip_permission: None,
    }))
}

fn run_web_fetch(args: &Value) -> String {
    let raw = arg_str(args, "url");
    let first = match check_url_literal(&raw) {
        Ok(u) => u,
        Err(reason) => return reason,
    };
    let agent = fetch_agent();
    let mut current: ParsedUrl = first;
    let mut resp: Option<ureq::Response> = None;

    // 手动跟随重定向：每一跳都重新过字面 + DNS 守卫
    for _hop in 0..=MAX_REDIRECTS {
        current = match check_url_literal(&current.raw) {
            Ok(u) => u,
            Err(reason) => return reason,
        };
        if let Err(reason) = assert_resolves_public(&current.host) {
            return reason;
        }
        let r = match agent.get(&current.raw).set("user-agent", "rcode-web-fetch/0.1").call() {
            Ok(r) => r,
            // redirects(0) 下 3xx 理论上以 Ok 返回；这里防御两种形状
            Err(ureq::Error::Status(code, r)) if (300..400).contains(&code) => r,
            Err(ureq::Error::Status(code, _r)) => return format!("错误：HTTP {}", code),
            Err(ureq::Error::Transport(t)) => return format!("错误：请求失败：{}", t),
        };
        resp = Some(r);
        if (300..400).contains(&resp.as_ref().unwrap().status()) {
            match resp.as_ref().unwrap().header("location") {
                Some(loc) => match join_redirect(&current, loc).and_then(|s| parse_url(&s)) {
                    Some(next) => {
                        current = next;
                        continue;
                    }
                    None => break,
                },
                None => break,
            }
        }
        break;
    }
    let r = match resp {
        Some(r) => r,
        None => return "错误：请求未发出".to_string(),
    };
    let status = r.status();
    if !(200..300).contains(&status) {
        let reason = r.status_text();
        return format!("错误：HTTP {} {}", status, reason).trim_end().to_string();
    }

    let ctype = r.header("content-type").unwrap_or("").to_string();
    let mut reader = r.into_reader().take(MAX_BYTES as u64);
    let mut buf = Vec::new();
    if let Err(e) = reader.read_to_end(&mut buf) {
        return format!("错误：读取响应失败：{}", e);
    }
    let body = String::from_utf8_lossy(&buf).to_string();
    let text = if ctype.to_lowercase().contains("html") { html_to_text(&body) } else { body };
    let max = (arg_number(args, "max_chars", DEFAULT_MAX_CHARS) as usize).max(200);
    let count = text.chars().count();
    let (out, note) = if count > max {
        (text.chars().take(max).collect::<String>(), format!("\n…（已截断，原文 {} 字符，可用 max_chars 调大）", count))
    } else {
        (text, String::new())
    };
    let display_type = if ctype.is_empty() { "未知类型" } else { &ctype };
    format!("HTTP {} · {} · {}\n\n{}{}", status, display_type, current.raw, out, note)
}

/// 极简 HTML→文本：去 script/style 与标签。不做实体全解码，够模型读即可。
fn html_to_text(html: &str) -> String {
    let s = strip_block_ci(html, "script");
    let s = strip_block_ci(&s, "style");
    // 去 <...> 标签
    let mut no_tags = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                if in_tag {
                    in_tag = false;
                    no_tags.push(' ');
                } else {
                    no_tags.push('>');
                }
            }
            _ if !in_tag => no_tags.push(ch),
            _ => {}
        }
    }
    // 折叠空格/制表符
    let mut flat = String::with_capacity(no_tags.len());
    let mut in_space = false;
    for ch in no_tags.chars() {
        if ch == ' ' || ch == '\t' {
            if !in_space {
                flat.push(' ');
                in_space = true;
            }
        } else {
            flat.push(ch);
            in_space = false;
        }
    }
    // 折叠 3+ 换行
    let mut out = String::with_capacity(flat.len());
    let mut nl = 0usize;
    for ch in flat.chars() {
        if ch == '\n' {
            nl += 1;
            if nl <= 2 {
                out.push('\n');
            }
        } else {
            nl = 0;
            out.push(ch);
        }
    }
    out.trim().to_string()
}

/// 大小写不敏感地删除 <tag ...> ... </tag ...> 区块（含闭合标签本体）。
fn strip_block_ci(s: &str, tag: &str) -> String {
    let lower = s.to_lowercase();
    let open = format!("<{}", tag);
    let close = format!("</{}", tag);
    let mut out = String::with_capacity(s.len());
    let mut pos = 0usize;
    loop {
        let start = match lower[pos..].find(&open) {
            Some(i) => pos + i,
            None => break,
        };
        // 区分 <script> 与 <scriptx>：标签名后必须是空白 / > / /
        let after_ok = lower[start + open.len()..]
            .chars()
            .next()
            .map_or(false, |c| c.is_whitespace() || c == '>' || c == '/');
        if !after_ok {
            // 假阳性：保留这个 '<'，从下一字节继续找
            out.push_str(&s[pos..start + 1]);
            pos = start + 1;
            continue;
        }
        out.push_str(&s[pos..start]);
        out.push(' ');
        let close_at = match lower[start..].find(&close) {
            Some(i) => start + i,
            None => {
                pos = s.len();
                break;
            }
        };
        let gt = match lower[close_at..].find('>') {
            Some(i) => close_at + i + 1,
            None => {
                pos = s.len();
                break;
            }
        };
        pos = gt;
    }
    out.push_str(&s[pos.min(s.len())..]);
    out
}
