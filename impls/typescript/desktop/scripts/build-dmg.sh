#!/bin/sh
# 无签名 DMG 打包：tauri 内置 DMG 步骤依赖 Finder AppleScript 摆放图标，
# 在无 Finder 自动化授权的环境必失败（osascript -10006）。
# DMG 本体用原生 hdiutil 直接打包；图标布局是纯装饰，省略。
# 签名/公证仍需 Apple 开发者账号，产物当前为未签名分发。
set -e
cd "$(dirname "$0")/.."
npm run build -- --bundles app
version=$(node -p "require('./src-tauri/tauri.conf.json').version")
arch=$(node -p "process.arch === 'arm64' ? 'aarch64' : 'x64'")
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
cp -R src-tauri/target/release/bundle/macos/tcode.app "$staging/"
ln -s /Applications "$staging/Applications"
mkdir -p "src-tauri/target/release/bundle/dmg"
rm -f "src-tauri/target/release/bundle/dmg/tcode_${version}_${arch}.dmg"
hdiutil create -volname tcode -srcfolder "$staging" -format UDZO "src-tauri/target/release/bundle/dmg/tcode_${version}_${arch}.dmg"
