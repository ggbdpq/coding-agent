// 工具插件集：一工具一文件；pathguard/netguard/rg 是共享工具函数，不是插件。
pub mod apply_patch;
pub mod bash;
pub mod edit;
pub mod glob;
pub mod grep;
pub mod netguard;
pub mod pathguard;
pub mod read;
pub mod rg;
pub mod todo;
pub mod webfetch;
pub mod write;

use serde_json::Value;

/// 取字符串参数（缺省/类型不符返回空串）。
pub(crate) fn arg_str(args: &Value, key: &str) -> String {
    args.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// 取数值参数；JSON 数值直接取，字符串数字顺带解析，缺省返回 def。
pub(crate) fn arg_number(args: &Value, key: &str, def: f64) -> f64 {
    match args.get(key) {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(def),
        Some(Value::String(s)) => s.parse().unwrap_or(def),
        _ => def,
    }
}

/// 取布尔参数（仅显式 true 为真）。
pub(crate) fn arg_bool(args: &Value, key: &str) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// 字节流 → UTF-8 字符串（损失容错），最多读 max 字节（防子进程巨量输出撑爆内存）。
pub(crate) fn read_lossy_capped(r: &mut dyn std::io::Read, max: usize) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match r.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if buf.len() < max {
                    let room = max - buf.len();
                    buf.extend_from_slice(&chunk[..n.min(room)]);
                }
                if buf.len() >= max {
                    // 继续排干但不累积，避免子进程因管道写满而阻塞
                    continue;
                }
            }
        }
    }
    String::from_utf8_lossy(&buf).to_string()
}
