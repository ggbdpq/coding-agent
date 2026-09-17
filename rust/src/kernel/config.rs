// 配置加载：环境变量 > ~/.rcode/config.json > 报错指路。
// 刻意不写死任何默认端点/模型——本地优先工具，用户自己决定请求发去哪。
// 协议选择不走这里：protocol 只有显式配置时才非空，自动识别由 provider 插件的 matches 做。

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::types::Protocol;

/// 装配所需的全部配置。
#[derive(Debug, Clone)]
pub struct Config {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    /// 仅显式配置（RCODE_PROTOCOL / config.json）时非空；否则由 provider 插件按 URL 自动识别
    pub protocol: Option<Protocol>,
    /// 估算 token 上限，超过即触发上下文裁剪
    pub context_limit: usize,
    /// ~/.rcode 目录，配置/会话/全局指令都住这里
    pub rcode_dir: PathBuf,
}

/// 用户主目录：Windows 先 USERPROFILE，其余平台 HOME（冒烟测试两个都注入）。
pub fn home_dir() -> Option<PathBuf> {
    for key in ["USERPROFILE", "HOME"] {
        if let Ok(v) = std::env::var(key) {
            if !v.trim().is_empty() {
                return Some(PathBuf::from(v));
            }
        }
    }
    None
}

/// 读 ~/.rcode/config.json；文件不存在返回空对象，解析失败报错指路。
fn read_json_config(rcode_dir: &Path) -> Result<Value, String> {
    let file = rcode_dir.join("config.json");
    let text = match std::fs::read_to_string(&file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Null),
        Err(e) => return Err(format!("~/.rcode/config.json 读取失败：{}", e)),
    };
    serde_json::from_str(&text).map_err(|e| format!("~/.rcode/config.json 解析失败：{}", e))
}

fn file_str(file: &Value, key: &str) -> String {
    file.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn first_non_empty(a: &str, b: &str) -> String {
    if !a.is_empty() {
        a.to_string()
    } else {
        b.to_string()
    }
}

/// 按优先级（环境变量 > 配置文件）加载配置；缺关键项时报中文指路。
pub fn load_config() -> Result<Config, String> {
    let home = home_dir().ok_or_else(|| "找不到用户主目录（HOME/USERPROFILE 均为空）".to_string())?;
    let rcode_dir = home.join(".rcode");
    let file = read_json_config(&rcode_dir)?;

    let api_key = first_non_empty(&std::env::var("RCODE_API_KEY").unwrap_or_default(), &file_str(&file, "apiKey"));
    let base_url = first_non_empty(&std::env::var("RCODE_BASE_URL").unwrap_or_default(), &file_str(&file, "baseUrl"))
        .trim_end_matches('/')
        .to_string();
    let model = first_non_empty(&std::env::var("RCODE_MODEL").unwrap_or_default(), &file_str(&file, "model"));
    let context_limit = match std::env::var("RCODE_CONTEXT_LIMIT").ok().and_then(|v| v.parse::<usize>().ok()) {
        Some(n) if n != 0 => n,
        _ => 100_000,
    };

    let mut protocol: Option<Protocol> = None;
    let raw_protocol = first_non_empty(
        &std::env::var("RCODE_PROTOCOL").unwrap_or_default().to_lowercase(),
        &file_str(&file, "protocol").to_lowercase(),
    );
    if !raw_protocol.is_empty() {
        protocol = Some(match raw_protocol.as_str() {
            "openai" => Protocol::OpenAI,
            "anthropic" => Protocol::Anthropic,
            _ => return Err(format!("RCODE_PROTOCOL 只能是 openai 或 anthropic，收到：{}", raw_protocol)),
        });
    }

    let missing: Vec<&str> = [
        ("RCODE_API_KEY", api_key.is_empty()),
        ("RCODE_BASE_URL", base_url.is_empty()),
        ("RCODE_MODEL", model.is_empty()),
    ]
    .iter()
    .filter(|(_, miss)| *miss)
    .map(|(k, _)| *k)
    .collect();
    if !missing.is_empty() {
        return Err(format!(
            "缺少模型配置：{}。\n设置方式（二选一）：\n  1. 环境变量：export RCODE_API_KEY=sk-xxx RCODE_BASE_URL=https://xxx/v1 RCODE_MODEL=模型名\n  2. 配置文件：~/.rcode/config.json 写 {{\"apiKey\":\"...\",\"baseUrl\":\"...\",\"model\":\"...\"}}\n任何 OpenAI 兼容端点都可以（本地中转、云 API 均可）。",
            missing.join("、")
        ));
    }
    Ok(Config { api_key, base_url, model, protocol, context_limit, rcode_dir })
}
