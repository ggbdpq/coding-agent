use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

/// 桌面宿主管理真实后端进程；运行目录只用来定位程序，工作区由 Web 设置。
pub struct Backend {
    child: Child,
}

pub fn backend_root(
    resources: Option<&Path>,
    development: Option<&Path>,
) -> Result<PathBuf, String> {
    resources
        .map(|dir| dir.join("backend"))
        .into_iter()
        .chain(development.map(Path::to_path_buf))
        .find(|root| {
            ["bin/tcode.js", "src/main.ts", "package.json"]
                .iter()
                .all(|file| root.join(file).is_file())
        })
        .ok_or_else(|| "未找到应用后端资源，请重新安装或重新打包 tcode。".into())
}

pub fn node_executable() -> OsString {
    if let Some(node) = std::env::var_os("TCODE_NODE").filter(|node| !node.is_empty()) {
        return node;
    }
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let mut candidates: Vec<PathBuf> =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|dir| dir.join(name))
            .collect();
    // Finder 的 PATH 常不含 Homebrew/fnm；只探测常用固定入口，不搜索整个用户目录。
    candidates.extend(
        [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ]
        .map(PathBuf::from),
    );
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join(".local/share/fnm/aliases/default/bin/node"));
    }
    if let Some(programs) = std::env::var_os("ProgramFiles") {
        candidates.push(PathBuf::from(programs).join("nodejs/node.exe"));
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .map(PathBuf::into_os_string)
        .unwrap_or_else(|| OsString::from(name))
}

impl Backend {
    pub fn start(node: &OsStr, root: &Path, timeout: Duration) -> Result<(Self, String), String> {
        let child = Command::new(node)
            .args(["bin/tcode.js", "web", "--desktop"])
            .current_dir(root)
            .stdout(Stdio::piped())
            // 错误页只展示宿主错误，避免模型配置或后端日志中的凭证被回显。
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => "未找到 Node 24。请安装 Node 24，或设置 TCODE_NODE 为 Node 可执行文件的绝对路径。".to_string(),
                _ => "无法启动 Node 后端，请检查 Node 可执行权限以及应用后端资源。".to_string(),
            })?;
        let mut backend = Self { child };
        let url = wait_backend_url(&mut backend.child, timeout)?;
        Ok((backend, url))
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn wait_backend_url(child: &mut Child, timeout: Duration) -> Result<String, String> {
    let stdout = child.stdout.take().ok_or("无法读取后端输出")?;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut ready = false;
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            // URL 只通知一次，随后继续读日志，避免关闭管道让 Node 遇到 EPIPE。
            if ready {
                continue;
            }
            let url = line.trim();
            if let Some(address) = url.strip_prefix("http://127.0.0.1:") {
                let port = address.split('/').next().unwrap_or_default();
                if port.bytes().all(|byte| byte.is_ascii_digit())
                    && port.parse::<u16>().is_ok_and(|port| port > 0)
                {
                    let _ = sender.send(url.to_string());
                    ready = true;
                }
            }
        }
    });
    match receiver.recv_timeout(timeout) {
        Ok(url) => Ok(url),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err("后端启动超时，请确认 Node 24 可用并重启应用。".into())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("后端未提供有效本地服务地址，请确认 Node 24 可用并重启应用。".into())
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new(script: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "tcode-desktop-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(dir.join("bin")).unwrap();
            fs::write(dir.join("bin/tcode.js"), script).unwrap();
            Self(dir)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn backend_that_never_announces_url_times_out() {
        let fixture = Fixture::new("echo $$ > backend.pid\nexec sleep 2\n");
        let started = Instant::now();
        let result = Backend::start(OsStr::new("sh"), &fixture.0, Duration::from_millis(100));
        assert!(result.is_err(), "无服务地址时应报告启动失败");
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "启动必须在超时后结束"
        );
        assert!(!process_exists(&fixture), "超时后不能遗留后端进程");
    }

    #[test]
    fn packaged_backend_starts_without_source_checkout() {
        let fixture = Fixture::new("echo http://127.0.0.1:43127\nexec sleep 2\n");
        let resources = fixture.0.join("resources");
        let bundled = resources.join("backend");
        fs::create_dir_all(bundled.join("src")).unwrap();
        fs::rename(fixture.0.join("bin"), bundled.join("bin")).unwrap();
        fs::write(bundled.join("src/main.ts"), "").unwrap();
        fs::write(bundled.join("package.json"), "{\"type\":\"module\"}").unwrap();
        let root = backend_root(Some(&resources), None).expect("发行版应从应用资源定位后端");
        let (backend, url) =
            Backend::start(OsStr::new("sh"), &root, Duration::from_millis(200)).unwrap();
        assert_eq!(url, "http://127.0.0.1:43127");
        drop(backend);
    }

    fn process_exists(fixture: &Fixture) -> bool {
        let pid = fs::read_to_string(fixture.0.join("backend.pid")).unwrap();
        Command::new("kill")
            .args(["-0", pid.trim()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    }

    #[test]
    fn closing_backend_reaps_its_process() {
        let fixture =
            Fixture::new("echo $$ > backend.pid\necho http://127.0.0.1:43127\nexec sleep 2\n");
        let (backend, _) =
            Backend::start(OsStr::new("sh"), &fixture.0, Duration::from_millis(200)).unwrap();
        assert!(process_exists(&fixture), "成功启动后应持有运行中的后端");
        drop(backend);
        assert!(!process_exists(&fixture), "宿主关闭后应终止并回收后端");
    }

    #[test]
    fn unavailable_node_gives_an_actionable_error() {
        let fixture = Fixture::new("");
        let result = Backend::start(
            OsStr::new("tcode-node-does-not-exist"),
            &fixture.0,
            Duration::from_millis(100),
        );
        let error = result.err().expect("缺 Node 时应失败");
        assert!(error.contains("Node 24") && error.contains("TCODE_NODE"));
    }

    #[test]
    fn failed_backend_does_not_expose_logs_or_navigate_to_remote_hosts() {
        let fixture = Fixture::new(
            "echo http://127.0.0.1.attacker.test\necho example-api-secret >&2\nexit 1\n",
        );
        let result = Backend::start(OsStr::new("sh"), &fixture.0, Duration::from_millis(100));
        let error = result.err().expect("只能接受准确的 loopback 服务地址");
        assert!(error.contains("有效本地服务地址"));
        assert!(
            !error.contains("example-api-secret"),
            "错误页不能回显后端原始日志"
        );
    }

    #[test]
    fn authenticated_backend_keeps_its_capability_path() {
        let fixture =
            Fixture::new("echo http://127.0.0.1:43127/t/example-test-token/\nexec sleep 2\n");
        let (backend, url) =
            Backend::start(OsStr::new("sh"), &fixture.0, Duration::from_millis(100))
                .expect("桌面必须保留后端的本地认证路径");
        assert_eq!(url, "http://127.0.0.1:43127/t/example-test-token/");
        drop(backend);
    }

    #[test]
    fn keeps_reading_stdout_after_ready() {
        let fixture = Fixture::new("set -e\necho http://127.0.0.1:43127/t/test/\nsleep 0.05\nprintf 'later backend output\\n'\necho alive > continued\nexec sleep 2\n");
        let (backend, _) =
            Backend::start(OsStr::new("sh"), &fixture.0, Duration::from_millis(300)).unwrap();
        std::thread::sleep(Duration::from_millis(150));
        assert!(
            fixture.0.join("continued").exists(),
            "启动后继续输出不能因 stdout 读端关闭而终止后端"
        );
        drop(backend);
    }
}
