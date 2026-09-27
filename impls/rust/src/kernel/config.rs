// 配置加载：环境变量 > ~/.rcode/config.json > 报错指路。
// 刻意不写死任何默认端点/模型——本地优先工具，用户自己决定请求发去哪。
// 协议选择不走这里：protocol 只有显式配置时才非空，自动识别由 provider 插件的 matches 做。

use std::path::{Component, Path, PathBuf};

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
    /// 审批策略（R4）：None=normal（写类逐次确认，默认）；Some("never")=全部免确认（--yolo 等价）。
    /// Codex 式 untrusted/on-failure 依赖 OS 沙箱，rcode 明确不做。
    pub approval: Option<String>,
    /// 写白名单（R4）：位于这些目录内的 write/edit 免确认（已归一化绝对路径）。
    /// bash/web_fetch 不受白名单影响（命令级操作无法按路径约束），仍逐次确认。
    pub allow_write_dirs: Vec<String>,
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

/// 平台路径列表分隔符：Windows 用 ';'，POSIX 用 ':'（对齐其余四版的 path.delimiter）。
fn path_list_separator() -> char {
    if cfg!(windows) {
        ';'
    } else {
        ':'
    }
}

#[cfg(test)]
mod tests {
    use super::path_list_separator;

    /// 家族契约：路径列表分隔符随平台（Windows ';' / POSIX ':'）。
    /// 本测试在 Windows 上恒绿（旧实现硬编码 ';' 恰好同值）；红能力在 POSIX runner 上
    /// 才成立——若有人改回硬编码 ';'，POSIX 上此测试即红。
    #[test]
    fn 路径列表分隔符随平台() {
        let expected = if cfg!(windows) { ';' } else { ':' };
        assert_eq!(path_list_separator(), expected);
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

    // 审批策略（R4）：RCODE_APPROVAL > config.json approval；只允许 normal/never，
    // 未配置即 None=normal（写类逐次确认）
    let raw_approval = first_non_empty(
        &std::env::var("RCODE_APPROVAL").unwrap_or_default().to_lowercase(),
        &file_str(&file, "approval").to_lowercase(),
    );
    let approval: Option<String> = if raw_approval.is_empty() {
        None
    } else {
        match raw_approval.as_str() {
            "normal" => Some("normal".to_string()),
            "never" => Some("never".to_string()),
            _ => return Err(format!("RCODE_APPROVAL 只能是 normal 或 never，收到：{}", raw_approval)),
        }
    };

    // 写白名单（R4）：config.json allowWriteDirs 优先，否则 RCODE_ALLOW_WRITE
    //（平台路径列表分隔符切分，对齐其余四版的 path.delimiter）。全部归一化为绝对路径；
    // 空段先跳过再归一——空串归一会静默得到 cwd，等于把整个工作目录送进白名单。
    let file_dirs: Vec<String> = file
        .get("allowWriteDirs")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let raw_dirs: Vec<String> = if !file_dirs.is_empty() {
        file_dirs
    } else {
        std::env::var("RCODE_ALLOW_WRITE")
            .unwrap_or_default()
            .split(path_list_separator())
            .map(str::to_string)
            .collect()
    };
    let allow_write_dirs: Vec<String> = raw_dirs
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| to_absolute(s))
        .collect();

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
    Ok(Config {
        api_key,
        base_url,
        model,
        protocol,
        approval,
        allow_write_dirs,
        context_limit,
        rcode_dir,
    })
}

/// 词法归一为绝对路径（同 path.resolve 语义：相对拼 cwd，"." 段去掉、".." 段上跳，
/// 不触盘）。kernel 不反向依赖 plugins/pathguard，此处自持最小实现。
fn to_absolute(input: &str) -> String {
    let p = Path::new(input);
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        cwd.join(p)
    };
    let mut out = PathBuf::new();
    for comp in joined.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                // 根前/前缀后的 ".." 无法再上跳时保留原样
                if !out.pop() {
                    out.push(comp.as_os_str());
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().to_string()
}
