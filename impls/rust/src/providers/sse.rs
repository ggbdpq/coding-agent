// SSE 共用件：从响应体流中逐事件产出 data 字段内容，OpenAI 与 Anthropic 两种协议通用。
// 手写解析：按空行分事件、取 data: 行、EOF 时残留半事件也收尾。
// 消费方回调返回 false 即停止读取（如收到 [DONE]）。
use std::io::{BufRead, BufReader};

pub fn sse_data<R: std::io::Read>(reader: R, mut on_data: impl FnMut(&str) -> bool) {
    let mut r = BufReader::new(reader);
    let mut lines: Vec<String> = Vec::new();
    loop {
        let mut line = String::new();
        match r.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let trimmed = line.trim_end_matches(|c| c == '\n' || c == '\r');
        if trimmed.is_empty() {
            if !lines.is_empty() {
                let data = lines.join("\n");
                lines.clear();
                if !on_data(&data) {
                    return;
                }
            }
        } else if let Some(v) = trimmed.strip_prefix("data:") {
            let v = v.trim();
            if !v.is_empty() {
                lines.push(v.to_string());
            }
        }
    }
    if !lines.is_empty() {
        on_data(&lines.join("\n"));
    }
}
