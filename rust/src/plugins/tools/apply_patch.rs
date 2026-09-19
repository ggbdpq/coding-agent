// apply_patch 工具：多文件原子编辑——先对全部编辑做预验（每条 old_string 必须在其
// 文件中存在且唯一/显式 replace_all），任一失败则整体不应用并逐条报告；全部通过后才写入。
// 原子性说明：预验与写入之间无并发写者（工具循环串行），因此"全预验→全写入"
// 即实际原子；安全边界：needs_permission 逐次确认（不设白名单豁免），preview 列出全部目标文件。
use std::collections::HashMap;
use std::rc::Rc;

use serde_json::Value;

use super::pathguard::resolve_path;
use crate::kernel::plugin::{Plugin, ToolDef};

/// 单条预验通过的编辑：(绝对路径, 展示路径, 缓存原文, 替换后全文)。
struct PreparedEdit {
    abs: std::path::PathBuf,
    display: String,
    next: String,
}

/// 取对象字段的字符串值（缺省/类型不符返回空串）。
fn field_str<'a>(e: &'a Value, key: &str) -> &'a str {
    e.get(key).and_then(Value::as_str).unwrap_or("")
}

pub fn apply_patch_plugin() -> Plugin {
    Plugin::Tool(Rc::new(ToolDef {
        name: "apply_patch",
        description: "对多个文件一次应用多处精确替换（原子操作：全部预验通过才写入，任一失败整体放弃）。适合跨文件的重命名/批量调整；单文件小改动仍优先用 edit。",
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "edits": {
                    "type": "array",
                    "description": "编辑列表，每项 {file_path, old_string, new_string, replace_all?}",
                    "items": {
                        "type": "object",
                        "properties": {
                            "file_path": {"type": "string"},
                            "old_string": {"type": "string"},
                            "new_string": {"type": "string"},
                            "replace_all": {"type": "boolean"}
                        },
                        "required": ["file_path", "old_string", "new_string"]
                    }
                }
            },
            "required": ["edits"]
        }),
        needs_permission: true,
        preview: Rc::new(|args: &Value| {
            let edits = args.get("edits").and_then(Value::as_array);
            let list = edits.map(|v| v.as_slice()).unwrap_or(&[]);
            // 去重保持首次出现顺序
            let mut files: Vec<String> = Vec::new();
            for e in list {
                let f = field_str(e, "file_path").to_string();
                if !files.contains(&f) {
                    files.push(f);
                }
            }
            let rows: Vec<String> = files.iter().map(|f| format!("  · {}", f)).collect();
            format!("原子补丁：{} 处编辑，涉及 {} 个文件\n{}", list.len(), files.len(), rows.join("\n"))
        }),
        run: Rc::new(|args: &Value| run_apply_patch(args)),
        skip_permission: None,
    }))
}

/// 两阶段执行：全量预验（读文件 + 存在性/唯一性检查，零写入）→ 全部通过才逐条写入。
fn run_apply_patch(args: &Value) -> String {
    let edits = args.get("edits").and_then(Value::as_array);
    let list = edits.map(|v| v.as_slice()).unwrap_or(&[]);
    if list.is_empty() {
        return "错误：edits 不能为空".to_string();
    }

    // 第一阶段：全量预验，不改任何磁盘内容
    let mut cache: HashMap<String, String> = HashMap::new();
    let mut prepared: Vec<PreparedEdit> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    for (i, e) in list.iter().enumerate() {
        let file = field_str(e, "file_path").to_string();
        let old_string = field_str(e, "old_string").to_string();
        let new_string = field_str(e, "new_string").to_string();
        let replace_all = e.get("replace_all").and_then(Value::as_bool).unwrap_or(false);
        if file.is_empty() || old_string.is_empty() {
            errors.push(format!("#{}：缺少 file_path 或 old_string", i));
            continue;
        }
        let original = if let Some(o) = cache.get(&file) {
            o.clone()
        } else {
            let abs = resolve_path(&file).abs;
            match std::fs::read_to_string(&abs) {
                Ok(t) => {
                    cache.insert(file.clone(), t.clone());
                    t
                }
                Err(_) => {
                    errors.push(format!("#{}：无法读取 {}", i, file));
                    continue;
                }
            }
        };
        let count = original.matches(&old_string).count();
        if count == 0 {
            errors.push(format!("#{}：{} 中未找到 old_string", i, file));
            continue;
        }
        if count > 1 && !replace_all {
            errors.push(format!(
                "#{}：{} 中 old_string 出现 {} 次（需 replace_all 或更多上下文）",
                i, file, count
            ));
            continue;
        }
        // 同文件多条编辑时各 next 都基于同一份缓存原文，后写覆盖前写（与 tcode 一致）
        let next = if replace_all && count > 1 {
            original.replace(&old_string, &new_string)
        } else {
            original.replacen(&old_string, &new_string, 1)
        };
        prepared.push(PreparedEdit { abs: resolve_path(&file).abs, display: file, next });
    }
    if !errors.is_empty() {
        let rows: Vec<String> = errors.iter().map(|s| format!("- {}", s)).collect();
        return format!("错误：预验未通过，未写入任何文件。\n{}", rows.join("\n"));
    }

    // 第二阶段：全部通过，按 prepared 顺序逐条写入
    for p in &prepared {
        if let Err(e) = std::fs::write(&p.abs, &p.next) {
            return format!("错误：写入失败：{}", e);
        }
    }
    let files: HashMap<&String, ()> = prepared.iter().map(|p| (&p.display, ())).collect();
    format!("已应用补丁：{} 处编辑，涉及 {} 个文件", prepared.len(), files.len())
}

#[cfg(test)]
mod tests {
    // apply_patch 原子补丁单测（镜像 tcode/test/patch.test.ts 三例）：
    // 全预验通过才写入；任一失败零写入并逐条报告；多处出现未开 replace_all 拒绝。
    use std::path::PathBuf;

    use serde_json::json;

    use super::*;

    /// 真实临时目录（已归一化绝对路径，避开 chdir 与转义纠缠）。
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rcode-patch-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 经插件壳取 run 回调（覆盖工具装配路径）。
    fn plugin_run(args: serde_json::Value) -> String {
        match apply_patch_plugin() {
            crate::kernel::plugin::Plugin::Tool(t) => (t.run)(&args),
            _ => panic!("apply_patch 应是工具插件"),
        }
    }

    #[test]
    fn 全部预验通过_多文件一次应用() {
        let dir = temp_dir("ok");
        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        std::fs::write(&a, "alpha\nbeta\n").unwrap();
        std::fs::write(&b, "hello\n").unwrap();
        let result = plugin_run(json!({"edits": [
            {"file_path": a.to_string_lossy(), "old_string": "alpha", "new_string": "ALPHA"},
            {"file_path": b.to_string_lossy(), "old_string": "hello", "new_string": "HELLO"}
        ]}));
        assert!(result.contains("已应用补丁：2 处编辑"), "实际：{}", result);
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "ALPHA\nbeta\n");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "HELLO\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 任一失败_零写入并逐条报告() {
        let dir = temp_dir("fail");
        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        std::fs::write(&a, "alpha\nbeta\n").unwrap();
        std::fs::write(&b, "hello\n").unwrap();
        let result = plugin_run(json!({"edits": [
            {"file_path": a.to_string_lossy(), "old_string": "alpha", "new_string": "ALPHA"},
            {"file_path": b.to_string_lossy(), "old_string": "不存在的原文", "new_string": "X"}
        ]}));
        assert!(result.contains("预验未通过"), "实际：{}", result);
        assert!(result.contains("未找到 old_string"), "实际：{}", result);
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "alpha\nbeta\n", "失败时 a 不应被改动");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "hello\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 多处出现未指定replace_all_拒绝该条() {
        let dir = temp_dir("multi");
        let a = dir.join("a.txt");
        std::fs::write(&a, "alpha\nbeta\n").unwrap();
        let result = plugin_run(json!({"edits": [
            {"file_path": a.to_string_lossy(), "old_string": "a", "new_string": "A"}
        ]}));
        assert!(result.contains("出现 3 次"), "实际：{}", result);
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "alpha\nbeta\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
