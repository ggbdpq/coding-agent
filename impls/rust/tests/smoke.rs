// 端到端冒烟（无网络）：本地手写假 SSE 服务器按剧本回包，被测对象是构建出的真二进制
// （子进程运行，HOME/USERPROFILE/RCODE_* 全部隔离到临时目录）。
// 场景对齐 tcode/test/smoke.mjs 的 A/B/C/D 区段；F 场景为 REPL 版权限确认：
// stdin 喂 y/n，断言 allow/deny 两轮（同 gcode 冒烟）。
// 剧本按"最后一条消息角色 + 最新用户文本"分场。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// 假服务器收到的每个请求体（带锁，cargo test 多线程下场景用全局锁串行化）。
static BODIES: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
static SERVER_URL: OnceLock<String> = OnceLock::new();
/// 场景互斥：保证请求体序列按场景分段，断言不受并发干扰。
static SCENARIO_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn bodies() -> &'static Mutex<Vec<String>> {
    BODIES.get_or_init(|| Mutex::new(Vec::new()))
}

fn scenario_lock() -> &'static Mutex<()> {
    SCENARIO_LOCK.get_or_init(|| Mutex::new(()))
}

/// 起 TcpListener + 假 SSE 服务器线程（每连接一线程，一请求一响应一关）。
fn start_server() -> String {
    if let Some(url) = SERVER_URL.get() {
        return url.clone();
    }
    let listener = TcpListener::bind("127.0.0.1:0").expect("冒烟：绑定假服务器失败");
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if let Ok(s) = stream {
                let _ = std::thread::spawn(move || handle_conn(s));
            }
        }
    });
    let url = format!("http://127.0.0.1:{}/v1", port);
    SERVER_URL.set(url.clone()).ok();
    url
}

/// 读一个 HTTP 请求（头 + Content-Length 定长的体），回 SSE 剧本，然后关连接。
fn handle_conn(mut stream: TcpStream) {
    // 1. 读请求头到空行
    let mut buf: Vec<u8> = Vec::new();
    let mut tmp = [0u8; 4096];
    let head_end = loop {
        if let Some(pos) = find(&buf, b"\r\n\r\n") {
            break pos;
        }
        match stream.read(&mut tmp) {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let content_length = head
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            if k.trim().eq_ignore_ascii_case("content-length") {
                v.trim().parse::<usize>().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);
    // 2. 读请求体
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < content_length {
        match stream.read(&mut tmp) {
            Ok(0) | Err(_) => break,
            Ok(n) => body.extend_from_slice(&tmp[..n]),
        }
    }
    let body_str = String::from_utf8_lossy(&body).to_string();
    bodies().lock().unwrap().push(body_str.clone());

    let request_line = head.lines().next().unwrap_or("");
    let path = request_line.split_whitespace().nth(1).unwrap_or("").to_string();

    // 3. 按剧本生成 SSE 响应字节
    let sse = script_response(&path, &body_str);
    let resp = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n{}",
        sse
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
    // drop 即关连接：无 content-length 的响应体以 EOF 结尾，ureq 可正常读完
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn send(obj: &Value) -> String {
    format!("data: {}\n\n", obj)
}

fn finish() -> String {
    "data: [DONE]\n\n".to_string()
}

/// OpenAI 风格的"两段正文 + DONE"收尾。
fn text_reply(content: &str, finish_reason: &str) -> String {
    format!(
        "{}{}{}",
        send(&json!({"choices": [{"delta": {"content": content}}]})),
        send(&json!({"choices": [{"delta": {}, "finish_reason": finish_reason}], "usage": {"prompt_tokens": 20, "completion_tokens": 3}})),
        finish()
    )
}

/// 按"最后一条消息角色 + 最新用户文本"分场（同 tcode 冒烟剧本）。
fn script_response(path: &str, raw: &str) -> String {
    // ---------- Anthropic 协议分支（/v1/messages） ----------
    if path.ends_with("/v1/messages") {
        if raw.contains("tool_result") {
            // 工具结果已回流：给最终回答
            return format!(
                "{}{}{}{}{}{}",
                send(&json!({"type": "message_start", "message": {"role": "assistant"}})),
                send(&json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text"}})),
                send(&json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "验证完成：smoke-anthropic"}})),
                send(&json!({"type": "content_block_stop", "index": 0})),
                send(&json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}})),
                send(&json!({"type": "message_stop"})),
            );
        }
        // 第一轮：正文 + 分两片的 tool_use input（考验碎片拼装）
        return format!(
            "{}{}{}{}{}{}{}{}{}{}",
            send(&json!({"type": "message_start", "message": {"role": "assistant"}})),
            send(&json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text"}})),
            send(&json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "我先跑个命令确认环境。"}})),
            send(&json!({"type": "content_block_stop", "index": 0})),
            send(&json!({"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "toolu_smoke", "name": "bash"}})),
            send(&json!({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{\"command\":"}})),
            send(&json!({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "\"echo smoke-anthropic\"}"}})),
            send(&json!({"type": "content_block_stop", "index": 1})),
            send(&json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}})),
            send(&json!({"type": "message_stop"})),
        );
    }

    // ---------- OpenAI 协议分支（/chat/completions） ----------
    let parsed: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
    let msgs = parsed["messages"].as_array().cloned().unwrap_or_default();
    let (last_role, last_text) = match msgs.last() {
        Some(m) => (
            m["role"].as_str().unwrap_or("").to_string(),
            m["content"].as_str().unwrap_or("").to_string(),
        ),
        None => (String::new(), String::new()),
    };

    if last_role == "tool" {
        // 工具结果已回流（含被拦截的 web_fetch）：给最终回答
        text_reply("验证完成：smoke-ok", "stop")
    } else if last_text.contains("继续") {
        // 场景B：恢复历史后的追问
        text_reply("好的，继续。", "stop")
    } else if last_text.contains("试试抓取") {
        // 场景D：诱导抓取内网地址，验证 SSRF 拦截
        format!(
            "{}{}{}{}",
            send(&json!({"choices": [{"delta": {"role": "assistant", "content": "我来抓取这个地址试试。"}}]})),
            send(&json!({"choices": [{"delta": {"tool_calls": [{
                "index": 0, "id": "call_fetch", "type": "function",
                "function": {"name": "web_fetch", "arguments": "{\"url\":\"http://127.0.0.1:9/private\"}"}
            }]}}]})),
            send(&json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 10, "completion_tokens": 5}})),
            finish()
        )
    } else {
        // 场景A第一轮：流式正文 + 一个 bash 工具调用
        format!(
            "{}{}{}{}",
            send(&json!({"choices": [{"delta": {"role": "assistant", "content": "我先跑个命令确认环境。"}}]})),
            send(&json!({"choices": [{"delta": {"tool_calls": [{
                "index": 0, "id": "call_smoke", "type": "function",
                "function": {"name": "bash", "arguments": "{\"command\":\"echo smoke-ok\"}"}
            }]}}]})),
            send(&json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 10, "completion_tokens": 5}})),
            finish()
        )
    }
}

// ---------- 子进程封装 ----------

struct Proc {
    child: Child,
    stdin: Option<ChildStdin>,
    out: std::sync::Arc<Mutex<String>>,
}

/// 启动被测二进制；HOME/USERPROFILE 与 RCODE_* 全部隔离（cwd=home）。
fn start_proc(home: &PathBuf, args: &[&str], env_extra: &[(&str, String)]) -> Proc {
    let exe = env!("CARGO_BIN_EXE_rcode").to_string();
    let mut cmd = Command::new(&exe);
    cmd.args(args).current_dir(home).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let env = isolated_env(home, env_extra);
    cmd.env_clear().envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));

    let mut child = cmd.spawn().expect("冒烟：启动子进程失败");
    let stdin = child.stdin.take();
    let out = std::sync::Arc::new(Mutex::new(String::new()));
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let out_h = out.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut f = stdout;
        while let Ok(n) = f.read(&mut buf) {
            if n == 0 {
                break;
            }
            out_h.lock().unwrap().push_str(&String::from_utf8_lossy(&buf[..n]));
        }
    });
    let err_h = out.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut f = stderr;
        while let Ok(n) = f.read(&mut buf) {
            if n == 0 {
                break;
            }
            err_h.lock().unwrap().push_str(&String::from_utf8_lossy(&buf[..n]));
        }
    });
    Proc { child, stdin, out }
}

/// 隔离环境：继承系统环境但去掉会干扰隔离的变量，注入假服务器与临时 HOME。
fn isolated_env(home: &PathBuf, env_extra: &[(&str, String)]) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = std::env::vars()
        .filter(|(k, _)| k != "HOME" && k != "USERPROFILE" && !k.starts_with("RCODE_"))
        .collect();
    env.push(("RCODE_API_KEY".into(), "test-key".into()));
    env.push(("RCODE_BASE_URL".into(), server_url()));
    env.push(("RCODE_MODEL".into(), "fake-model".into()));
    env.push(("HOME".into(), home.to_string_lossy().to_string()));
    env.push(("USERPROFILE".into(), home.to_string_lossy().to_string()));
    for (k, v) in env_extra {
        env.push(((*k).to_string(), v.clone()));
    }
    env
}

fn server_url() -> String {
    start_server()
}

impl Proc {
    fn write_line(&mut self, s: &str) {
        let stdin = self.stdin.as_mut().expect("stdin 已关闭");
        stdin.write_all(s.as_bytes()).expect("写 stdin 失败");
        stdin.write_all(b"\n").expect("写 stdin 失败");
        stdin.flush().ok();
    }

    fn snapshot(&self) -> String {
        self.out.lock().unwrap().clone()
    }

    /// 等输出里出现 substr。
    fn wait_contains(&self, substr: &str, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        loop {
            if self.snapshot().contains(substr) {
                return;
            }
            if Instant::now() > deadline {
                panic!("等不到输出 {:?}；已有：\n{}", substr, truncate_out(&self.snapshot()));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// 等输出里 substr 出现至少 n 次（用于第二轮同名提示）。
    fn wait_contains_n(&self, substr: &str, n: usize, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        loop {
            if self.snapshot().matches(substr).count() >= n {
                return;
            }
            if Instant::now() > deadline {
                panic!("等不到输出 {:?} ×{}；已有：\n{}", substr, n, truncate_out(&self.snapshot()));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// 写 /exit 并等进程退出。
    fn send_exit(&mut self) {
        if let Some(stdin) = self.stdin.as_mut() {
            let _ = stdin.write_all(b"/exit\n");
            let _ = stdin.flush();
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => return,
            }
        }
        panic!("子进程未在 5s 内退出；输出：\n{}", truncate_out(&self.snapshot()));
    }
}

impl Drop for Proc {
    fn drop(&mut self) {
        self.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn truncate_out(s: &str) -> String {
    if s.chars().count() > 8000 {
        format!("{}\n…（冒烟输出过长已截断）", s.chars().take(8000).collect::<String>())
    } else {
        s.to_string()
    }
}

fn bodies_snapshot() -> usize {
    bodies().lock().unwrap().len()
}

fn body_contains(from: usize, substrs: &[&str]) -> bool {
    let bs = bodies().lock().unwrap();
    bs[from..].iter().any(|b| substrs.iter().all(|s| b.contains(s)))
}

fn assert_contains(out: &str, subs: &[&str]) {
    for s in subs {
        assert!(out.contains(s), "输出缺 {:?}；实际：\n{}", s, truncate_out(out));
    }
}

fn temp_home(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "rcode-smoke-{}-{}-{}",
        tag,
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

// ---------- 场景 ----------

/// A：--yolo 工具闭环——流式正文 → 工具调用 → bash 执行 → 结果回流 → 最终回答。
#[test]
fn smoke_a_tool_loop() {
    let _guard = scenario_lock().lock().unwrap();
    start_server();
    let home = temp_home("a");
    let mut p = start_proc(&home, &["--yolo"], &[]);
    p.write_line("跑一下冒烟测试");
    p.wait_contains("验证完成：smoke-ok", Duration::from_secs(30));
    p.send_exit();

    let out = p.snapshot();
    assert_contains(&out, &["我先跑个命令确认环境。", "验证完成：smoke-ok", "exit=0", "smoke-ok"]);
    assert!(body_contains(0, &["\"role\":\"tool\"", "smoke-ok"]), "A: 第二轮请求未携带工具结果");
    let _ = std::fs::remove_dir_all(&home);
}

/// B：/resume 恢复会话并携带历史发给模型。
#[test]
fn smoke_b_resume() {
    let _guard = scenario_lock().lock().unwrap();
    start_server();
    let home = temp_home("b");
    // 先造一个有历史的会话（复用 A 的剧本）
    let mut p0 = start_proc(&home, &["--yolo"], &[]);
    p0.write_line("跑一下冒烟测试");
    p0.wait_contains("验证完成：smoke-ok", Duration::from_secs(30));
    p0.send_exit();

    let before = bodies_snapshot();
    let mut p = start_proc(&home, &[], &[]);
    p.write_line("/resume");
    p.wait_contains("最近的会话", Duration::from_secs(15));
    p.write_line("/resume 1");
    p.wait_contains("已恢复", Duration::from_secs(15));
    p.write_line("继续");
    p.wait_contains("好的，继续。", Duration::from_secs(30));
    p.send_exit();

    let out = p.snapshot();
    assert_contains(&out, &["最近的会话", "跑一下冒烟测试", "已恢复", "好的，继续。"]);
    assert!(
        body_contains(before, &["跑一下冒烟测试", "继续"]),
        "B: 恢复的历史未随新请求发给模型"
    );
    let _ = std::fs::remove_dir_all(&home);
}

/// C：Anthropic 协议（BASE_URL 含 /anthropic 自动识别）完整工具轮，含分片 input_json_delta。
#[test]
fn smoke_c_anthropic() {
    let _guard = scenario_lock().lock().unwrap();
    start_server();
    let home = temp_home("c");
    let before = bodies_snapshot();
    let mut p = start_proc(
        &home,
        &["--yolo"],
        &[("RCODE_BASE_URL", format!("{}/anthropic", server_url()))],
    );
    p.write_line("跑一下 Anthropic 冒烟");
    p.wait_contains("验证完成：smoke-anthropic", Duration::from_secs(30));
    p.send_exit();

    let out = p.snapshot();
    assert_contains(&out, &["我先跑个命令确认环境。", "验证完成：smoke-anthropic", "smoke-anthropic"]);
    assert!(
        body_contains(before, &["\"tool_result\"", "smoke-anthropic"]),
        "C: 第二轮请求未携带 tool_result"
    );
    assert!(
        body_contains(before, &["\"input_schema\"", "\"max_tokens\"", "\"system\""]),
        "C: 请求缺 Anthropic 必备字段（input_schema/max_tokens/system）"
    );
    let _ = std::fs::remove_dir_all(&home);
}

/// D：诱导 web_fetch 抓内网地址，断言 SSRF 拦截且结果回流、会话正常收尾。
#[test]
fn smoke_d_ssrf_block() {
    let _guard = scenario_lock().lock().unwrap();
    start_server();
    let home = temp_home("d");
    let before = bodies_snapshot();
    let mut p = start_proc(&home, &["--yolo"], &[]);
    p.write_line("试试抓取 http://127.0.0.1:9/private");
    p.wait_contains("已拦截", Duration::from_secs(30));
    p.wait_contains("验证完成：smoke-ok", Duration::from_secs(30));
    p.send_exit();

    assert_contains(&p.snapshot(), &["SSRF 防护"]);
    assert!(
        body_contains(before, &["\"role\":\"tool\"", "SSRF 防护"]),
        "D: 拦截结果未回流给模型"
    );
    let _ = std::fs::remove_dir_all(&home);
}

/// F：无 --yolo，stdin 喂 y/n 断言权限 allow/deny 两轮。
#[test]
fn smoke_f_permission() {
    let _guard = scenario_lock().lock().unwrap();
    start_server();
    let home = temp_home("f");
    let before = bodies_snapshot();
    let mut p = start_proc(&home, &[], &[]);
    p.write_line("跑一下冒烟测试");
    p.wait_contains("允许?", Duration::from_secs(30)); // 第一轮：bash 权限询问
    assert_contains(&p.snapshot(), &["echo smoke-ok"]); // 预览应含将执行的命令
    p.write_line("y");
    p.wait_contains("验证完成：smoke-ok", Duration::from_secs(30));

    p.write_line("再来一次");
    p.wait_contains_n("允许?", 2, Duration::from_secs(30)); // 第二轮：同名询问（计数区分）
    p.write_line("n");
    p.wait_contains("用户已拒绝", Duration::from_secs(30));
    p.send_exit();

    assert!(
        body_contains(before, &["用户拒绝了本次操作"]),
        "F: 拒绝回执未回流给模型"
    );
    let _ = std::fs::remove_dir_all(&home);
}

/// H：exec 位置参数形态——`rcode exec --yolo "任务"` 无交互跑通工具闭环后退出 0；
/// 任务里带 @引用，一并验证 exec 与 REPL 共用的 @引用展开接线。
#[test]
fn smoke_h_exec() {
    let _guard = scenario_lock().lock().unwrap();
    start_server();
    let home = temp_home("h");
    std::fs::write(home.join("task.txt"), "hint-atref-ok").unwrap();
    let before = bodies_snapshot();
    let exe = env!("CARGO_BIN_EXE_rcode");
    let out = Command::new(exe)
        .args(["exec", "--yolo", "跑一下冒烟测试 @task.txt"])
        .current_dir(&home)
        .env_clear()
        .envs(isolated_env(&home, &[]).iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .output()
        .expect("冒烟 H：启动子进程失败");
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    assert_eq!(
        out.status.code(),
        Some(0),
        "exec 完成应以 0 退出；stdout：\n{}\nstderr：\n{}",
        truncate_out(&stdout),
        truncate_out(&stderr)
    );
    assert_contains(&stdout, &["我先跑个命令确认环境。", "[tool] bash", "[result]", "验证完成：smoke-ok"]);
    assert!(
        body_contains(before, &["\"role\":\"tool\"", "smoke-ok"]),
        "H: 第二轮请求未携带工具结果"
    );
    assert!(
        body_contains(before, &["[引用文件 task.txt]", "hint-atref-ok"]),
        "H: @引用 内容未注入发给模型的任务文本"
    );
    let _ = std::fs::remove_dir_all(&home);
}

/// H 反例：exec 不带 --yolo 必须拒绝执行并以退出码 1 收尾（无交互环境无法逐次确认）。
#[test]
fn smoke_h2_exec_requires_yolo() {
    let _guard = scenario_lock().lock().unwrap();
    start_server();
    let home = temp_home("h2");
    let exe = env!("CARGO_BIN_EXE_rcode");
    let out = Command::new(exe)
        .args(["exec", "跑一下冒烟测试"])
        .current_dir(&home)
        .env_clear()
        .envs(isolated_env(&home, &[]).iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .output()
        .expect("冒烟 H2：启动子进程失败");
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    assert_eq!(out.status.code(), Some(1), "exec 缺 --yolo 应以 1 退出");
    assert!(stderr.contains("--yolo"), "错误信息应指向 --yolo；实际：{}", truncate_out(&stderr));
    let _ = std::fs::remove_dir_all(&home);
}
