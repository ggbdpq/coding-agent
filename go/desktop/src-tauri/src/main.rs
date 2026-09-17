// gcode 桌面壳：拉起 `node bin/gcode.js web`，等它打印本地地址后把窗口导过去。
// ponytail: 自用版——node 取自系统 PATH，后端目录用编译期路径；打包分发
// （内置 Node 运行时）等有真实需求再说。后端起不来时把 stderr 原话展示在窗口里
//（十有八九是 ~/.gcode/config.json 没配）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct Backend(Mutex<Option<Child>>);

fn kill_backend(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Backend>() {
        if let Some(mut child) = state.0.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// 阻塞读后端 stdout，直到出现本地服务地址；进程退出则把 stderr 原话带回
fn wait_backend_url(child: &mut Child) -> Result<String, String> {
    let stdout = child.stdout.take().ok_or("无法读取后端输出")?;
    let mut stderr_pipe = child.stderr.take();
    let err_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(e) = stderr_pipe.as_mut() {
            let _ = e.read_to_end(&mut buf);
        }
        String::from_utf8_lossy(&buf).to_string()
    });
    for line in BufReader::new(stdout).lines() {
        match line {
            Ok(l) if l.starts_with("http://127.0.0.1") => return Ok(l.trim().to_string()),
            Ok(_) => {}
            Err(e) => return Err(format!("读取后端输出失败：{e}")),
        }
    }
    let err = err_handle.join().unwrap_or_default();
    Err(if err.trim().is_empty() {
        "后端进程退出且未给出服务地址".into()
    } else {
        err.trim().to_string()
    })
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
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
         <h2 style=\"color:#f85149\">gcode 后端启动失败</h2>\
         <p>多半是还没配模型（写一份 ~/.gcode/config.json 即可），后端原话：</p>\
         <pre>{}</pre></body>",
        html_escape(msg)
    );
    format!("data:text/html;charset=utf-8,{}", percent_encode(&html))
        .parse()
        .map_err(|e| format!("构造错误页失败：{e}"))
}

fn main() {
    // 编译期定位 gcode 项目根（src-tauri 的上两级），自用版足够
    let gcode_root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");

    tauri::Builder::default()
        .setup(move |app| {
            let child = Command::new("node")
                .args(["bin/gcode.js", "web"])
                .current_dir(gcode_root)
                .env("GCODE_NO_OPEN", "1")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("启动后端失败（需要系统 PATH 里有 Node 24）：{e}"))?;
            let mut child = child;

            match wait_backend_url(&mut child) {
                Ok(url) => {
                    // 终端启动时把服务地址透传出来（测试与排障都靠它）
                    println!("{url}");
                    let parsed: tauri::Url = url
                        .parse()
                        .map_err(|e| format!("服务地址解析失败：{e}"))?;
                    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
                        .title("gcode")
                        .inner_size(1100.0, 800.0)
                        .min_inner_size(700.0, 500.0)
                        .build()?;
                    app.manage(Backend(Mutex::new(Some(child))));
                    Ok(())
                }
                Err(msg) => {
                    let page = error_page_url(&msg)?;
                    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(page))
                        .title("gcode · 启动失败")
                        .inner_size(900.0, 600.0)
                        .build()?;
                    // 后端进程已退出，不纳入托管
                    Ok(())
                }
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                kill_backend(window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("gcode 桌面壳运行失败");
}
