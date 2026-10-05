# tcode 桌面版

Tauri 2 窗口复用 `tcode web`。首次打开在界面里选择项目目录和配置模型；后端程序所在目录不会自动成为操作工作区。一次打开一个项目，串行执行任务。

运行需要 **Node 24**。应用依次使用 `TCODE_NODE`、系统 PATH、Homebrew 常用路径、fnm 默认入口和 Windows `ProgramFiles/nodejs`；其他版本管理器可通过 `TCODE_NODE` 指定 Node 可执行文件。此版本没有内置 Node 运行时。

在此目录使用已有 Tauri CLI 开发或打包：

```sh
npm run dev
npm run build -- --bundles app,dmg  # macOS
npm run build -- --bundles nsis     # Windows
```

开发还需要 Rust 和对应平台的 Tauri 编译环境。打包把 `../bin/`、`../src/`、`../package.json` 放入应用的 `backend/` 资源目录；发行版不依赖原始源码位置，也不打包 `node_modules`。开发模式允许直接使用源码目录。

启动等待上限为 15 秒。缺 Node、缺资源、后端提前退出或超时均展示可操作的错误页；失败和关窗都会终止并回收后端进程。错误页不回显后端原始日志。

“选择项目目录”调用系统原生目录对话框（macOS `NSOpenPanel`、Windows 文件夹选择、Linux GTK），取消返回 `null`，不会修改工作区。桌面通过 `window.__TAURI__.core.invoke('select_workspace')` 返回所选现有目录的绝对路径，由工作台保存和切换项目。命令不接受网页传入路径或任意系统命令，也不向网页开放文件系统插件。

由于后端端口随机，宿主启动时仅为当前 `main` 窗口和 `http://127.0.0.1:PORT` 来源添加这一个命令的动态能力。Tauri 的 fetch IPC 只带 Origin，因此认证路径由命令读取实际窗口 URL 后严格核对；其他端口、认证路径、外站及本地 Tauri 页面均不能调用。目录选择直接复用 `rfd`，不引入额外前端依赖。

启动边界回归（macOS/Linux，有已缓存的 Rust 依赖时）：

```sh
npm run test:startup
```

也可绕过 Tauri 依赖，直接检查真实子进程启动逻辑：

```sh
rustc --edition=2021 --test src-tauri/src/backend.rs -o /tmp/tcode-desktop-backend-tests
/tmp/tcode-desktop-backend-tests
```

这些检查覆盖超时清理、关窗对应的进程回收、缺 Node、非本地地址拒绝、凭证不回显、认证路径保留、启动后日志持续读取，以及应用资源与源码位置分离；另通过真正的 Tauri IPC/ACL 验证目录选择的成功、取消、无效目录和未授权来源。IPC 测试仅替换操作系统对话框的返回值。

2026-10-05 本地验收：基础版本的原生目录对话框可打开并完成项目切换，取消后保留原项目。本轮从独立的 `develop` 提交快照重新构建 macOS `.app`，包内 89 个后端资源逐文件核对一致；浏览器已验收项目归档／恢复及跨项目搜索。DMG、Windows 安装包及 Windows/Linux 原生对话框尚未实机验收。
