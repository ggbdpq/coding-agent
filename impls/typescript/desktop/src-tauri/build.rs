fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["select_workspace"])),
    )
    .expect("生成桌面命令权限失败")
}
