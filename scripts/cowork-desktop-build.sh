#!/bin/bash
# 编桌面版 dodoer.app（Apple Silicon，ad-hoc 签名），冒烟，打成发布用的文件。跑在 GitHub 托管的 macOS 机器上（公开镜像的 desktop-macos.yml）。
# 只有一种包：完整版，自带 codeg-server 子进程做本机 daemon；主窗口是开始页，本机工作区和服务器上的工作区都从那里开
# （COWORK.md「桌面端：一种包、开始页」）。2026-11-09 以前还有一种纯客户端版，已经去掉。
#
#   用法：scripts/cowork-desktop-build.sh [full]（参数可省，只认 full）
#   环境：VERSION（桌面版本号 1.Y.Z）、TAURI_SIGNING_PRIVATE_KEY（+ _PASSWORD）；
#        GITHUB_OUTPUT 有就写 full_name / full_updater
#
# 经 beforeBuildCommand 编前端（out/）和 sidecar（src-tauri/binaries/）。清空 dist/，产物都在 dist/：
#   dodoer-<ver>-<sha8>-macos-arm64.zip(.sha256)             安装包
#   dodoer-macos-arm64.zip(.sha256)                          同一个文件、名字不带版本（releases/latest/download/… 直接指它）
#   dodoer-client-macos-arm64.zip(.sha256)                   还是同一个文件：门户「桌面版」的下载链接（以前给纯客户端版）指这个名字，留着不让它 404
#   dodoer-<ver>-macos-arm64.app.tar.gz(.sig)                自动更新包  ← latest.json 和 latest-client.json
# latest.json / latest-client.json 由 workflow 在发布时生成，两个都指这个自动更新包：装过纯客户端版的 app 从 latest-client.json
# 查更新（endpoint 编在它自己的包里），这样它就更新成完整版。
set -euo pipefail

edition="${1:-full}"
: "${VERSION:?VERSION=1.Y.Z}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

fail() { echo "::error::$*" >&2; exit 1; }

bundle="$root/src-tauri/target/release/bundle/macos"
app="$bundle/dodoer.app"
releases=https://github.com/Tinghecui/dodoer-releases/releases/latest/download
configs=(--config src-tauri/tauri.jenny.conf.json --config src-tauri/tauri.cowork-desktop.conf.json)
[[ "$edition" == full ]] || fail "不认识的版本 ${edition}：只有 full（纯客户端版 2026-11-09 已经去掉）"
prefix=dodoer
expect_endpoint="$releases/latest.json"

echo "==> [$edition] tauri build（只出 .app，ad-hoc 签名，版本 ${VERSION}）"
rm -f "$bundle"/dodoer.app.tar.gz*
rm -rf "$app"
# tauri.cowork-desktop.conf.json 打开自动更新（我们的公钥和 dodoer-releases 的 latest.json），
# createUpdaterArtifacts 让 bundle 里多出 dodoer.app.tar.gz + .sig
pnpm tauri build --bundles app "${configs[@]}" \
  --config "{\"version\":\"$VERSION\",\"bundle\":{\"macOS\":{\"signingIdentity\":\"-\"}}}"
test -d "$app" || fail "没编出 $app"

echo "==> [$edition] 冒烟"
exe=$(defaults read "$app/Contents/Info.plist" CFBundleExecutable)
ver=$(defaults read "$app/Contents/Info.plist" CFBundleShortVersionString)
[[ "$ver" == "$VERSION" ]] || fail "编出来的版本 $ver 不是 $VERSION"
# 包自己说它是哪一版、从哪更新（codeg --desktop-edition）：更新地址来自 Tauri 配置，叠错了就会从别处更新，所以核对。
# 用 node 解析（不依赖 jq）
report=$("$app/Contents/MacOS/$exe" --desktop-edition)
echo "$report"
REPORT="$report" EDITION="$edition" ENDPOINT="$expect_endpoint" node -e '
  const r = JSON.parse(process.env.REPORT);
  const fail = (m) => { console.error("::error::" + m); process.exit(1); };
  if (r.edition !== process.env.EDITION) fail(`包说自己是 ${r.edition}，要的是 ${process.env.EDITION}`);
  const ep = r.updaterEndpoints;
  if (!Array.isArray(ep) || ep.length !== 1 || ep[0] !== process.env.ENDPOINT)
    fail(`updater endpoints 是 ${JSON.stringify(ep)}，要的是 ${process.env.ENDPOINT}`);
  if (r.version !== process.env.VERSION) fail(`包里的版本 ${r.version} 不是 ${process.env.VERSION}`);
'
# daemon 是 app 里自带的 codeg-server 子进程（src-tauri/src/local_daemon.rs）。用打好的 .app 自己跑一遍：
# 起子进程（临时数据目录）、/api/health 带 token 200、错 token 401、kill -9 之后自动重启、停掉后进程不在。
# 不开窗口，不碰这台机器上真的 dodoer 数据
server="$app/Contents/MacOS/codeg-server"
test -x "$server" || { ls -la "$app/Contents/MacOS"; fail "$server 不在 bundle 里"; }
[[ $(stat -f %z "$server") -gt 1000000 ]] || fail "$server 是占位文件，prepare-sidecars 没编它"
for other in codeg-mcp codeg-cli; do
  test -x "$app/Contents/MacOS/$other" || fail "$other 不在 bundle 里"
done
"$app/Contents/MacOS/$exe" --local-daemon-smoke

echo "==> [$edition] 打成 zip，自动更新包重签（绑定版本号）"
name="$prefix-$ver-$(git rev-parse --short=8 HEAD)-macos-arm64"
# clean: false 下 dist/ 不会被清，先删掉，不然 artifact 里夹着以前每次的 zip
rm -rf dist && mkdir dist
ditto -c -k --keepParent "$app" "dist/$name.zip"
# 在 dist 里算，.sha256 里只写文件名，下载解压后直接 `shasum -a 256 -c` 就能核对
(cd dist && shasum -a 256 "$name.zip" | tee "$name.zip.sha256")
# 自动更新包：bundle 自己签的那份不带版本号，app 开着 requireSignedVersion 会拒，用 --app-version 重签
upd="$prefix-$ver-macos-arm64.app.tar.gz"
cp "$bundle/dodoer.app.tar.gz" "dist/$upd"
pnpm tauri signer sign --app-version "$ver" "dist/$upd" >/dev/null
base64 -d < "dist/$upd.sig" | grep -q "version:$ver" || fail "$upd.sig 里没有 version:$ver"
# 不带版本号的两个名字：dodoer-macos-arm64.zip，和门户下载链接用的 dodoer-client-macos-arm64.zip，内容都是这个安装包
for alias in "$prefix-macos-arm64.zip" "$prefix-client-macos-arm64.zip"; do
  cp "dist/$name.zip" "dist/$alias"
  (cd dist && shasum -a 256 "$alias" | tee "$alias.sha256")
done
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "${edition}_name=$name" >> "$GITHUB_OUTPUT"
  echo "${edition}_updater=$upd" >> "$GITHUB_OUTPUT"
fi
rm -f "$bundle"/dodoer.app.tar.gz*
# 打完包把 bundle 里的 .app 删掉并从 LaunchServices 注销：在自己的 Mac 上跑时，留着的话 Spotlight /
# 「打开方式」里会多出一个 dodoer，codeg:// 链接也可能被它接走。编译缓存在 target/release 别处，不受影响
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$app" || true
rm -rf "$app"
echo "==> [$edition] 完成：dist/$name.zip、dist/$upd"
