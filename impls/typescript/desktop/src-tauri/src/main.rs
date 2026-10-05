// tcode 桌面壳：从应用资源启动本地后端；工作区和模型在界面中配置。
// ponytail: 复用系统 Node 24；需要独立分发运行时再加入 Node sidecar。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod workspace;

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct BackendState(Mutex<Option<backend::Backend>>);

fn kill_backend(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<BackendState>() {
        // take 后立即 Drop：关窗与窗口创建失败共用同一清理入口。
        let _ = state.0.lock().unwrap().take();
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn error_page_url(msg: &str) -> Result<tauri::Url, String> {
    let html = format!(
        "<body style=\"font-family:monospace;background:#101418;color:#d6dde6;padding:24px\">\
         <h2 style=\"color:#f85149\">tcode 后端启动失败</h2>\
         <p>请按以下提示检查环境，然后重新打开应用。</p>\
         <pre>{}</pre></body>",
        html_escape(msg)
    );
    format!("data:text/html;charset=utf-8,{}", percent_encode(&html))
        .parse()
        .map_err(|e| format!("构造错误页失败：{e}"))
}

fn desktop_context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![workspace::select_workspace])
        .setup(|app| {
            let resources = app.path().resource_dir().ok();
            // 发行版只使用随应用打包的资源；开发模式可直接读取源码。
            let development = cfg!(debug_assertions)
                .then(|| Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../..")));
            let result =
                backend::backend_root(resources.as_deref(), development).and_then(|root| {
                    backend::Backend::start(
                        &backend::node_executable(),
                        &root,
                        Duration::from_secs(15),
                    )
                });

            match result {
                Ok((backend, url)) => {
                    // 终端启动时把服务地址透传出来（测试与排障都靠它）
                    println!("{url}");
                    let parsed: tauri::Url =
                        url.parse().map_err(|e| format!("服务地址解析失败：{e}"))?;
                    workspace::enable(app, parsed.clone())?;
                    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
                        .title("tcode")
                        .inner_size(1100.0, 800.0)
                        .min_inner_size(700.0, 500.0)
                        .build()?;
                    app.manage(BackendState(Mutex::new(Some(backend))));
                    Ok(())
                }
                Err(msg) => {
                    let page = error_page_url(&msg)?;
                    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(page))
                        .title("tcode · 启动失败")
                        .inner_size(900.0, 600.0)
                        .build()?;
                    // 启动失败时进程已由 Backend::drop 清理。
                    Ok(())
                }
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                kill_backend(window.app_handle());
            }
        })
        .run(desktop_context())
        .expect("tcode 桌面壳运行失败");
}
