// 路径守卫：解析模型给的路径，并标注目标是否越出当前工作目录。
// rcode 的安全边界是权限确认（人工把关），本模块的职责是把越界目标
// 显式带出来，让确认界面能看到 "../" 或绝对路径这类穿越意图，而不是静默放行。
// 非插件，是工具共享的工具函数。
use std::path::{Component, Path, PathBuf};

pub struct ResolvedPath {
    pub abs: PathBuf,
    /// true = 目标在当前工作目录之外，写类操作确认时会醒目提示
    pub outside: bool,
}

/// 词法归一：去掉 "." 段、消化 ".." 段（不触盘，符合 path.resolve 语义）。
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                // 绝对路径到达根后不再上跳；仅无根路径保留无法消解的 ".."。
                if !out.pop() && !out.has_root() {
                    out.push(comp.as_os_str());
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 把模型给的路径解析为绝对路径并判断是否越出工作目录。
pub fn resolve_path(input: &str) -> ResolvedPath {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let p = Path::new(input);
    let joined = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
    let abs = normalize(&joined);
    let outside = !within(&abs, &cwd);
    ResolvedPath { abs, outside }
}

/// 解析符号链接后的真实路径；目标不存在时解析最近的已存在祖先再拼回剩余段。
fn real_path(p: &Path) -> PathBuf {
    let mut rest = Vec::new();
    let mut cur = p;
    loop {
        if let Ok(r) = cur.canonicalize() {
            return rest.iter().rev().fold(r, |acc, c| acc.join(c));
        }
        match (cur.parent(), cur.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_os_string());
                cur = parent;
            }
            _ => return p.to_path_buf(),
        }
    }
}

/// 两侧都解析符号链接后再按分量比较，防止 root 内的符号链接把目标引到 root 外。
fn within(target: &Path, root: &Path) -> bool {
    real_path(target).starts_with(real_path(root))
}

/// 白名单判定（R4）：目标词法归一为绝对路径后，落在 config.allow_write_dirs
/// 任一目录内（目录本身或其子路径）→ true。未配置/无法解析一律 false（仍逐次确认）。
/// 只有 write/edit 接这个判定；bash/web_fetch 不设（命令级操作无法按路径约束）。
pub(crate) fn in_allow_write_dirs(app: &crate::kernel::app::App, target: &str) -> bool {
    if app.config.allow_write_dirs.is_empty() || target.trim().is_empty() {
        return false;
    }
    let t = resolve_path(target).abs;
    // 分量级 starts_with 已排除前缀同名字符串（/a/b 不匹配 /a/bc）
    app.config
        .allow_write_dirs
        .iter()
        .any(|d| within(&t, Path::new(d)))
}

#[cfg(test)]
mod allowwrite_tests {
    // 白名单免确认判定（R4，镜像 tcode/test/approval.test.ts 四例）：
    // 白名单内免确认 / 外仍确认 / 未配置一律确认 / edit 同 write。
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::rc::Rc;

    use serde_json::Value;

    use super::*;
    use crate::kernel::app::{create_app, App, AppOptions, SessionStoreLike, SessionSummary};
    use crate::kernel::config::Config;
    use crate::kernel::plugin::{Plugin, ProviderDef, Registry};
    use crate::kernel::types::{ChatClient, ChatMessage, ChatOptions, CompletionResult};

    struct NoopStore;

    impl SessionStoreLike for NoopStore {
        fn start(&mut self, _meta: Value) {}
        fn append(&mut self, _message: &ChatMessage) {}
        fn list_recent(&self, _n: usize) -> Vec<SessionSummary> {
            vec![]
        }
        fn load(&self, _file: &str) -> Vec<ChatMessage> {
            vec![]
        }
    }

    struct NoProvider;

    impl ChatClient for NoProvider {
        fn chat(&self, _messages: &[ChatMessage], _opts: &ChatOptions) -> Result<CompletionResult, crate::kernel::types::ChatError> {
            Ok(CompletionResult { message: ChatMessage::assistant(None, vec![]) })
        }
    }

    fn fake_app(allow_write_dirs: &[&str]) -> App {
        let mut registry = Registry::new();
        registry
            .register(Plugin::Provider(Rc::new(ProviderDef {
                name: "fake",
                matches: Rc::new(|_base_url: &str| true),
                create: Rc::new(|_config| Rc::new(NoProvider) as Rc<dyn ChatClient>),
            })))
            .unwrap();
        create_app(
            Config {
                api_key: "k".into(),
                base_url: "http://127.0.0.1".into(),
                model: "fake".into(),
                protocol: None,
                approval: None,
                allow_write_dirs: allow_write_dirs.iter().map(|s| s.to_string()).collect(),
                context_limit: 1_000_000,
                rcode_dir: PathBuf::from("/tmp"),
            },
            registry,
            AppOptions { yolo: false, fresh_messages: Box::new(Vec::new), store: Rc::new(RefCell::new(NoopStore)) },
        )
        .unwrap()
    }

    /// 用真实临时目录构造两侧路径（已归一化绝对路径，避开 chdir 与大小写纠缠）。
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rcode-allowwrite-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn 白名单内_免确认() {
        let root = temp_dir("in");
        let app = fake_app(&[&root.to_string_lossy()]);
        let target = root.join("out.txt");
        assert!(in_allow_write_dirs(&app, &target.to_string_lossy()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn 白名单外_仍需确认() {
        let root = temp_dir("out");
        let other = temp_dir("other");
        let app = fake_app(&[&root.to_string_lossy()]);
        assert!(!in_allow_write_dirs(&app, &other.join("a.txt").to_string_lossy()));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn 未配置白名单_一律确认() {
        let app = fake_app(&[]);
        assert!(!in_allow_write_dirs(&app, "whatever.txt"));
    }

    #[test]
    fn 目录本身_免确认_前缀同名目录不误收() {
        let root = temp_dir("root");
        let app = fake_app(&[&root.to_string_lossy()]);
        assert!(in_allow_write_dirs(&app, &root.to_string_lossy()), "根目录本身应免确认");
        // 兄弟目录共享前缀字符串（如 /a/b vs /a/bc）不得误判为白名单内
        let sibling = root.to_string_lossy().to_string() + "c";
        assert!(!in_allow_write_dirs(&app, &format!("{}{}x.txt", sibling, std::path::MAIN_SEPARATOR)));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn 白名单内符号链接指向外部_仍需确认() {
        let root = temp_dir("link");
        let other = temp_dir("linktarget");
        std::os::unix::fs::symlink(&other, root.join("link")).unwrap();
        let app = fake_app(&[&root.to_string_lossy()]);
        assert!(!in_allow_write_dirs(&app, &root.join("link").join("x.txt").to_string_lossy()));
        assert!(!within(&root.join("link").join("x.txt"), &root));
        assert!(within(&root.join("new").join("x.txt"), &root), "不存在的子路径仍在内");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
    }
}
