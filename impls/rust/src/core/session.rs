// 会话持久化：JSONL 追加写，一行一条 JSON（meta 行 + message 行）。
// /resume 的语义 = 读旧文件、换新文件继续写——避免追加到可能损坏的旧文件。
// 目录边界：所有读写都限定在会话目录内，出目录一律拒绝/跳过。
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

use crate::kernel::app::SessionSummary;
use crate::kernel::app::SessionStoreLike;
use crate::kernel::types::ChatMessage;

/// 会话 JSONL 存储。
pub struct SessionStore {
    file_path: Option<PathBuf>,
    /// 归一化后的会话目录绝对路径
    root: PathBuf,
}

impl SessionStore {
    /// 打开会话目录（不存在则创建）。
    pub fn new(dir: &Path) -> Result<Self, String> {
        let root = std::fs::canonicalize(dir).or_else(|_| {
            std::fs::create_dir_all(dir).map_err(|e| format!("创建会话目录失败：{}", e))?;
            std::fs::canonicalize(dir).map_err(|e| format!("解析会话目录失败：{}", e))
        })?;
        Ok(SessionStore { file_path: None, root })
    }

    /// 目录边界校验：目标必须是本目录本身或本目录的直接/间接子路径。
    fn is_inside_dir(&self, target: &Path) -> bool {
        target == self.root || target.starts_with(&self.root)
    }

    /// 读指定会话文件的全部消息行；越出会话目录的路径一律拒绝。
    fn read_label(&self, file: &Path) -> String {
        if !self.is_inside_dir(file) {
            return "(无用户消息)".to_string();
        }
        let data = match std::fs::read_to_string(file) {
            Ok(d) => d,
            Err(_) => return "(无用户消息)".to_string(),
        };
        for line in data.split('\n') {
            if line.trim().is_empty() {
                continue;
            }
            let o: Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue, // 跳过坏行
            };
            if o["type"] == "message" && o["message"]["role"] == "user" {
                let text = o["message"]["content"].as_str().unwrap_or("").trim();
                let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
                if !collapsed.is_empty() {
                    return collapsed.chars().take(60).collect();
                }
            }
        }
        "(无用户消息)".to_string()
    }
}

impl SessionStoreLike for SessionStore {
    /// 开新会话文件并写入元信息行。
    fn start(&mut self, meta: Value) {
        // Windows 文件名禁 :，把 ISO 时间的冒号一并换掉
        let (y, mo, d, h, mi, s, ms) = utc_parts();
        let name = format!(
            "{:04}-{:02}-{:02}T{:02}-{:02}-{:02}-{:03}-{:04x}.jsonl",
            y, mo, d, h, mi, s, ms, random_suffix()
        );
        let file = self.root.join(name);
        if !self.is_inside_dir(&file) {
            return; // 防御式自检：文件名不含分隔符，理论到不了这里
        }
        self.file_path = Some(file.clone());
        let mut entry = Map::new();
        entry.insert("type".into(), Value::String("meta".into()));
        entry.insert("ts".into(), serde_json::json!(unix_millis()));
        if let Value::Object(meta_map) = meta {
            for (k, v) in meta_map {
                entry.insert(k, v);
            }
        }
        if let Ok(mut f) = std::fs::File::create(&file) {
            let _ = writeln!(f, "{}", Value::Object(entry));
        }
    }

    /// 追加一条消息；落盘失败静默（记会话是锦上添花，不该打断对话）。
    fn append(&mut self, message: &ChatMessage) {
        let Some(path) = &self.file_path else { return };
        let line = Value::Object({
            let mut m = Map::new();
            m.insert("type".into(), Value::String("message".into()));
            m.insert("message".into(), message.to_value());
            m
        });
        // append 模式打开失败/写入失败都静默
        if let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).open(path) {
            let _ = writeln!(f, "{}", line);
        }
    }

    /// 最近 n 个会话（排除当前文件），按修改时间倒序。
    fn list_recent(&self, n: usize) -> Vec<SessionSummary> {
        let entries = match std::fs::read_dir(&self.root) {
            Ok(it) => it,
            Err(_) => return vec![],
        };
        let mut files: Vec<SessionSummary> = Vec::new();
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.ends_with(".jsonl") {
                continue;
            }
            let file = self.root.join(&name);
            if !self.is_inside_dir(&file) || Some(&file) == self.file_path.as_ref() {
                continue;
            }
            let mtime = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            files.push(SessionSummary { file: file.to_string_lossy().to_string(), mtime, label: String::new() });
        }
        files.sort_by(|a, b| b.mtime.cmp(&a.mtime));
        files.truncate(n);
        for f in &mut files {
            f.label = self.read_label(Path::new(&f.file));
        }
        files
    }

    /// 读指定会话文件的全部消息行；越出会话目录的路径一律拒绝。
    fn load(&self, file: &str) -> Vec<ChatMessage> {
        let resolved = match std::fs::canonicalize(file) {
            Ok(p) => p,
            Err(_) => return vec![],
        };
        if !self.is_inside_dir(&resolved) {
            return vec![];
        }
        let data = match std::fs::read_to_string(&resolved) {
            Ok(d) => d,
            Err(_) => return vec![],
        };
        let mut messages = Vec::new();
        for line in data.split('\n') {
            if line.trim().is_empty() {
                continue;
            }
            let o: Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue, // 跳过坏行
            };
            if o["type"] == "message" {
                if let Some(m) = ChatMessage::from_value(&o["message"]) {
                    messages.push(m);
                }
            }
        }
        messages
    }
}

/// 毫秒时间戳（当前时刻）。
pub(crate) fn unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 当前 UTC 时间拆件（年 月 日 时 分 秒 毫秒）。不引 chrono，civil 算法手写。
pub(crate) fn utc_parts() -> (i64, u32, u32, u32, u32, u32, u32) {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let millis = d.subsec_millis();
    let days = secs.div_euclid(86400);
    let sod = secs.rem_euclid(86400);
    let (y, m, dd) = civil_from_days(days);
    (y, m, dd, (sod / 3600) as u32, (sod % 3600 / 60) as u32, (sod % 60) as u32, millis)
}

/// 今天的 UTC 日期（YYYY-MM-DD），systemprompt 用。
pub(crate) fn today_utc() -> String {
    let (y, m, d, _, _, _, _) = utc_parts();
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// 天数 → (年, 月, 日)；Howard Hinnant 的 civil_from_days 算法。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 文件名后缀：时间纳秒 + 进程号混合散列，进程内连续创建也不会重名。
fn random_suffix() -> u32 {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().subsec_nanos();
    let mut x = nanos ^ (std::process::id() << 9);
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    x & 0xffff
}
