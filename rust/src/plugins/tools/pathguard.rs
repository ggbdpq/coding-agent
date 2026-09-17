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
                // 根前/前缀后的 ".." 无法再上跳时保留原样
                if !out.pop() {
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
    let outside = !abs.starts_with(&cwd);
    ResolvedPath { abs, outside }
}
