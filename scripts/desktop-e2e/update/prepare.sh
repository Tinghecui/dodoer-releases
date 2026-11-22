#!/bin/bash
# 更新流程测试的准备（公开镜像 desktop-e2e.yml 在 macOS 上调）：一把测试用的更新签名密钥、两个测试包、一个模拟的旧纯客户端版。
# - 密钥：这次 run 现做（tauri signer generate，空密码），只在运行机的临时目录里。公钥经 CODEG_E2E_UPDATER_PUBKEY 交给 e2e 测试版
#   （src-tauri/src/e2e.rs），不编进任何包。真的签名私钥（dodoer-releases 的 Secret）这里碰不到，也不用
# - N = 1.999.0：编出来的 e2e 测试版 .app 原样（ad-hoc 重签）；N+1 = 1.999.1：同一个 .app，Info.plist 的版本号改成 1.999.1 再 ad-hoc 签。
#   e2e 测试版按 Info.plist 的版本号运行（e2e::with_bundle_version），所以不用为 N+1 再编一遍主程序（macOS 上十分钟）
# - 两个都打成更新包 dodoer-<版本>-macos-<架构>.app.tar.gz，用测试私钥签（--app-version 绑版本号，app 开着 requireSignedVersion）
# - 模拟的旧纯客户端版：N 的 .app 去掉 codeg-server（2026-11-09 以前的纯客户端版就是不带它），测「从 latest-client.json 更新成完整版」
#
#   用法：scripts/desktop-e2e/update/prepare.sh <e2e 测试版的 dodoer.app> <输出目录>
#   输出：<输出目录>/feed/（更新包 + .sig）、<输出目录>/apps/{1.999.0,1.999.1,client}/dodoer.app、<输出目录>/keys/（测试密钥）、
#        <输出目录>/arch（arm64 或 x64）
# macOS 自带 bash 3.2：变量后面紧跟全角字符要写 ${x}。
# 来历：源仓库 .cowork/journal/2026-11-22-e2e-update-feed.md
set -euo pipefail

src="${1:?e2e 测试版的 dodoer.app}"
out="${2:?输出目录}"
here="$(cd "$(dirname "$0")" && pwd)"
tauri="$here/../node_modules/.bin/tauri"
test -d "$src/Contents/MacOS" || { echo "::error::${src} 不是 .app" >&2; exit 1; }
test -x "$tauri" || { echo "::error::没有 ${tauri}（scripts/desktop-e2e 里先 npm install）" >&2; exit 1; }

case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) echo "::error::不认识的架构 $(uname -m)" >&2; exit 1 ;;
esac

rm -rf "$out"
mkdir -p "$out/feed" "$out/apps" "$out/keys"
echo "$arch" > "$out/arch"

# 测试密钥：空密码。--ci 不问
"$tauri" signer generate --ci -p "" -w "$out/keys/e2e-updater.key" > /dev/null
test -s "$out/keys/e2e-updater.key.pub" || { echo "::error::没生成测试公钥" >&2; exit 1; }

# 一个版本的 .app：拷一份，改 Info.plist 的版本号，ad-hoc 重签
make_app() {
  local version="$1" dir="$out/apps/$1" plist
  mkdir -p "$dir"
  ditto "$src" "$dir/dodoer.app"
  plist="$dir/dodoer.app/Contents/Info.plist"
  plutil -replace CFBundleShortVersionString -string "$version" "$plist"
  plutil -replace CFBundleVersion -string "$version" "$plist"
  plutil -convert xml1 "$plist"
  codesign --force --deep --sign - "$dir/dodoer.app" > /dev/null 2>&1
  codesign --verify --deep --strict "$dir/dodoer.app"
}

# 更新包：tar.gz 里第一层是 dodoer.app（同 tauri 打的），不带 macOS 的 ._ 扩展属性文件
make_package() {
  local version="$1" pkg="dodoer-$1-macos-$arch.app.tar.gz" t0
  t0=$(date +%s)
  COPYFILE_DISABLE=1 tar -czf "$out/feed/$pkg" -C "$out/apps/$version" dodoer.app
  "$tauri" signer sign -f "$out/keys/e2e-updater.key" -p "" --app-version "$version" "$out/feed/$pkg" > /dev/null
  base64 -d < "$out/feed/$pkg.sig" | grep -q "version:$version" || { echo "::error::${pkg}.sig 里没有 version:${version}" >&2; exit 1; }
  echo "- 测试更新包 ${pkg}：$(( $(stat -f %z "$out/feed/$pkg") / 1048576 )) MB，$(( $(date +%s) - t0 )) 秒"
}

for v in 1.999.0 1.999.1; do
  make_app "$v"
  make_package "$v"
done

# 模拟的旧纯客户端版：版本 1.999.0，不带 codeg-server
mkdir -p "$out/apps/client"
ditto "$out/apps/1.999.0/dodoer.app" "$out/apps/client/dodoer.app"
rm -f "$out/apps/client/dodoer.app/Contents/MacOS/codeg-server"
codesign --force --deep --sign - "$out/apps/client/dodoer.app" > /dev/null 2>&1
echo "- 模拟的旧纯客户端版：1.999.0，去掉了 codeg-server"
