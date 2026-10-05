use tauri::ipc::CapabilityBuilder;
use tauri::{Manager, Runtime, Url, WebviewWindow};

struct PickerState(Url);

/// IPC Origin 不含页面路径；仅授权当前服务的动态端口，命令再核对完整认证 URL。
pub fn enable<R: Runtime>(app: &tauri::App<R>, url: Url) -> tauri::Result<()> {
    app.add_capability(
        CapabilityBuilder::new("workspace-picker")
            .remote(format!("{}/*", url.origin().ascii_serialization()))
            .local(false)
            .window("main")
            .permission("allow-select-workspace"),
    )?;
    app.manage(PickerState(url));
    Ok(())
}

#[tauri::command]
pub async fn select_workspace<R: Runtime>(
    window: WebviewWindow<R>,
) -> Result<Option<String>, String> {
    let state = window.state::<PickerState>();
    if window.label() != "main" || window.url().map_err(|_| "无法读取工作台地址")? != state.0
    {
        return Err("只有当前工作台可以选择项目目录".into());
    }
    // 系统选择器是唯一输入来源；命令不接收网页提供的路径或命令。
    #[cfg(not(test))]
    let selected = rfd::FileDialog::new()
        .set_parent(&window)
        .set_title("选择项目目录")
        .set_can_create_directories(false)
        .pick_folder();
    #[cfg(test)]
    let selected = window.state::<SystemDialogFixture>().0.clone();

    let Some(path) = selected else {
        return Ok(None);
    };
    if !path.is_absolute() {
        return Err("系统选择器未返回绝对目录，请重新选择".into());
    }
    let path = path
        .canonicalize()
        .map_err(|_| "所选目录无法访问，请重新选择")?;
    if !path.is_dir() {
        return Err("请选择项目目录，不能选择文件".into());
    }
    path.into_os_string()
        .into_string()
        .map(Some)
        .map_err(|_| "所选目录路径不是有效 UTF-8".into())
}

// 仅替换操作系统对话框返回值；回归仍走真正的 Tauri IPC、ACL 和目录校验。
#[cfg(test)]
struct SystemDialogFixture(Option<std::path::PathBuf>);

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::{ipc, test, webview::InvokeRequest, WebviewUrl, WebviewWindowBuilder};

    const URL: &str = "http://127.0.0.1:43127/t/example-test-token/";

    fn fixture(
        selection: Option<std::path::PathBuf>,
        label: &str,
    ) -> (
        tauri::App<test::MockRuntime>,
        WebviewWindow<test::MockRuntime>,
    ) {
        fixture_at(selection, label, URL)
    }

    fn fixture_at(
        selection: Option<std::path::PathBuf>,
        label: &str,
        window_url: &str,
    ) -> (
        tauri::App<test::MockRuntime>,
        WebviewWindow<test::MockRuntime>,
    ) {
        let app = test::mock_builder()
            .invoke_handler(tauri::generate_handler![select_workspace])
            .manage(SystemDialogFixture(selection))
            .build(crate::desktop_context())
            .unwrap();
        let url: Url = URL.parse().unwrap();
        enable(&app, url.clone()).unwrap();
        let window = WebviewWindowBuilder::new(
            &app,
            label,
            WebviewUrl::External(window_url.parse().unwrap()),
        )
        .build()
        .unwrap();
        (app, window)
    }

    fn invoke(
        window: &WebviewWindow<test::MockRuntime>,
        url: &str,
    ) -> Result<Option<String>, String> {
        test::get_ipc_response(
            window,
            InvokeRequest {
                cmd: "select_workspace".into(),
                callback: ipc::CallbackFn(0),
                error: ipc::CallbackFn(1),
                url: url.parse().unwrap(),
                body: ipc::InvokeBody::default(),
                headers: Default::default(),
                invoke_key: test::INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<Option<String>>().unwrap())
        .map_err(|error| error.to_string())
    }

    #[test]
    fn cancel_workspace_selection_returns_null_through_ipc() {
        let (_app, window) = fixture(None, "main");
        assert_eq!(
            invoke(&window, URL),
            Ok(None),
            "取消系统目录选择必须返回 null"
        );
    }

    #[test]
    fn origin_only_native_ipc_transport_can_select_from_the_authenticated_page() {
        let (_app, window) = fixture(None, "main");
        assert_eq!(
            invoke(&window, "http://127.0.0.1:43127/"),
            Ok(None),
            "fetch/custom-protocol IPC 的 Origin 不含认证路径，但当前窗口仍是认证工作台"
        );
    }

    #[test]
    fn invalid_relative_selection_is_not_silently_resolved_against_the_application() {
        let (_app, window) = fixture(Some(".".into()), "main");
        assert!(
            invoke(&window, URL).is_err(),
            "选择器必须返回绝对目录，不能以应用路径代替用户选择"
        );
    }

    #[test]
    fn selected_directory_is_absolute_canonical_and_supports_unicode() {
        let dir = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("tcode-picker-{}-中文 目录", std::process::id()));
        let expected = dir.to_str().unwrap().to_string();
        std::fs::create_dir_all(&dir).unwrap();
        #[cfg(unix)]
        let selection = {
            let alias = dir.with_file_name(format!("tcode-picker-alias-{}", std::process::id()));
            std::os::unix::fs::symlink(&dir, &alias).unwrap();
            alias
        };
        #[cfg(not(unix))]
        let selection = dir.clone();
        let (_app, window) = fixture(Some(selection.clone()), "main");
        let result = invoke(&window, URL);
        #[cfg(unix)]
        std::fs::remove_file(&selection).unwrap();
        std::fs::remove_dir(&dir).unwrap();
        assert_eq!(
            result,
            Ok(Some(expected)),
            "系统所选目录必须原样返回绝对路径"
        );
    }

    #[test]
    fn missing_directory_and_regular_file_are_rejected() {
        let path = std::env::temp_dir().join(format!("tcode-picker-file-{}", std::process::id()));
        let (_missing_app, missing_window) = fixture(Some(path.clone()), "main");
        assert!(invoke(&missing_window, URL)
            .unwrap_err()
            .contains("无法访问"));
        std::fs::write(&path, "a file is not a workspace").unwrap();
        let (_file_app, file_window) = fixture(Some(path.clone()), "main");
        let result = invoke(&file_window, URL);
        std::fs::remove_file(path).unwrap();
        assert!(result.unwrap_err().contains("不能选择文件"));
    }

    #[test]
    fn unrelated_urls_and_windows_cannot_open_the_native_picker() {
        let (_app, window) = fixture(None, "main");
        for url in [
            "https://example.com/",
            "http://127.0.0.1.attacker.test:43127/t/example-test-token/",
            "http://127.0.0.1:43128/t/example-test-token/",
            "tauri://localhost/",
        ] {
            assert!(invoke(&window, url).is_err(), "不能授权不相关地址：{url}");
        }
        let (_other_app, other_window) = fixture(None, "other-window");
        assert!(
            invoke(&other_window, URL).is_err(),
            "只有 main 窗口获准调用"
        );
        // fetch IPC 只带 Origin：必须检查实际窗口地址，不能把报文路径当成页面地址。
        for window_url in [
            "http://127.0.0.1:43127/t/wrong-token/",
            "http://127.0.0.1:43127/",
        ] {
            let (_wrong_app, wrong_window) = fixture_at(None, "main", window_url);
            assert!(
                invoke(&wrong_window, "http://127.0.0.1:43127/")
                    .unwrap_err()
                    .contains("只有当前工作台"),
                "同源但未持有认证路径的页面仍必须被拒绝：{window_url}"
            );
        }
    }
}
