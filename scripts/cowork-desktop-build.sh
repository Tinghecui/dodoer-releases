#!/bin/bash
# 编一种桌面版 dodoer.app（Apple Silicon，ad-hoc 签名），冒烟，打成发布用的文件。跑在 GitHub 托管的 macOS 机器上（公开镜像的 desktop-macos.yml）。
# desktop-macos.yml 调两次：先 full（完整版，自带 codeg-server 子进程做本机 daemon），再 client（纯客户端版，
# 不带 codeg-server、只连服务器，Cowork 用户装这个）。两种是同一份代码：client 多叠一个 Tauri 配置
# （src-tauri/tauri.cowork-client.conf.json：externalBin 去掉 codeg-server、updater 指到 latest-client.json）
# 和一个 Cargo feature（client-only，src-tauri/src/local_daemon.rs 的 CLIENT_ONLY_BUILD）。
#
#   用法：scripts/cowork-desktop-build.sh full|client
#   环境：VERSION（桌面版本号 1.Y.Z）、TAURI_SIGNING_PRIVATE_KEY（+ _PASSWORD）；
#        GITHUB_OUTPUT 有就写 <edition>_name / <edition>_updater（client 还有 client_alias）
#
# full 先跑：它清空 dist/，并经 beforeBuildCommand 编前端（out/）和 sidecar（src-tauri/binaries/）。client 后跑，
# 复用这两样（beforeBuildCommand 换成 true），只重编 Rust（feature 变了）。产物都在 dist/：
#   dodoer-<ver>-<sha8>-macos-arm64.zip(.sha256)             完整版安装包
#   dodoer-<ver>-macos-arm64.app.tar.gz(.sig)                完整版自动更新包  ← latest.json
#   dodoer-client-<ver>-<sha8>-macos-arm64.zip(.sha256)      纯客户端版安装包
#   dodoer-client-macos-arm64.zip(.sha256)                   同一个文件、名字不带版本：门户的下载链接指这个（releases/latest/download/…）
#   dodoer-client-<ver>-macos-arm64.app.tar.gz(.sig)         纯客户端版自动更新包  ← latest-client.json
# 两条更新线各自的 latest*.json 由 workflow 在发布时生成。装了哪种就只会更新成哪种：endpoint 编在各自的包里。
set -euo pipefail

edition="${1:?用法：$0 full|client}"
: "${VERSION:?VERSION=1.Y.Z}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

fail() { echo "::error::$*" >&2; exit 1; }

bundle="$root/src-tauri/target/release/bundle/macos"
app="$bundle/dodoer.app"
releases=https://github.com/Tinghecui/dodoer-releases/releases/latest/download
configs=(--config src-tauri/tauri.jenny.conf.json --config src-tauri/tauri.cowork-desktop.conf.json)
# mac 自带的 bash 3.2 在 set -u 下展开空数组会报 unbound variable，所以下面用 ${features[@]+"${features[@]}"}
features=()
case "$edition" in
  full)
    prefix=dodoer
    expect_endpoint="$releases/latest.json"
    ;;
  client)
    prefix=dodoer-client
    expect_endpoint="$releases/latest-client.json"
    configs+=(--config src-tauri/tauri.cowork-client.conf.json)
    # 前端和 sidecar 是 full 那次编好的；没有就说明顺序错了
    triple=$(rustc -vV | sed -n 's/^host: //p')
    test -d out || fail "没有 out/：先跑 $0 full"
    test -s "src-tauri/binaries/codeg-mcp-$triple" || fail "没有编好的 sidecar：先跑 $0 full"
    configs+=(--config '{"build":{"beforeBuildCommand":"true"}}')
    features=(--features client-only)
    ;;
  *) fail "不认识的版本 ${edition}（full|client）" ;;
esac

echo "==> [$edition] tauri build（只出 .app，ad-hoc 签名，版本 ${VERSION}）"
rm -f "$bundle"/dodoer.app.tar.gz*
rm -rf "$app"
# tauri.cowork-desktop.conf.json 打开自动更新（我们的公钥和 dodoer-releases 的 latest.json），
# createUpdaterArtifacts 让 bundle 里多出 dodoer.app.tar.gz + .sig
pnpm tauri build --bundles app "${configs[@]}" \
  --config "{\"version\":\"$VERSION\",\"bundle\":{\"macOS\":{\"signingIdentity\":\"-\"}}}" \
  ${features[@]+"${features[@]}"}
test -d "$app" || fail "没编出 $app"

echo "==> [$edition] 冒烟"
exe=$(defaults read "$app/Contents/Info.plist" CFBundleExecutable)
ver=$(defaults read "$app/Contents/Info.plist" CFBundleShortVersionString)
[[ "$ver" == "$VERSION" ]] || fail "编出来的版本 $ver 不是 $VERSION"
# 包自己说它是哪一版、从哪更新（codeg --desktop-edition）：edition 来自 Cargo feature、更新地址来自 Tauri 配置，
# 两样对不上就会把自己更新成另一种版本，所以两样都核对。用 node 解析（不依赖 jq）
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
server="$app/Contents/MacOS/codeg-server"
if [[ "$edition" == full ]]; then
  # 完整版：daemon 是 app 里自带的 codeg-server 子进程（src-tauri/src/local_daemon.rs）。用打好的 .app 自己跑一遍：
  # 起子进程（临时数据目录）、/api/health 带 token 200、错 token 401、kill -9 之后自动重启、停掉后进程不在。
  # 不开窗口，不碰这台机器上真的 dodoer 数据
  test -x "$server" || { ls -la "$app/Contents/MacOS"; fail "$server 不在 bundle 里"; }
  [[ $(stat -f %z "$server") -gt 1000000 ]] || fail "$server 是占位文件，prepare-sidecars 没编它"
  "$app/Contents/MacOS/$exe" --local-daemon-smoke
else
  # 纯客户端版：不能带 codeg-server（带了就是配置叠错了）
  [[ ! -e "$server" ]] || fail "纯客户端版的 bundle 里不该有 codeg-server"
  for other in codeg-mcp codeg-cli; do
    test -x "$app/Contents/MacOS/$other" || fail "$other 不在 bundle 里"
  done
fi

echo "==> [$edition] 打成 zip，自动更新包重签（绑定版本号）"
name="$prefix-$ver-$(git rev-parse --short=8 HEAD)-macos-arm64"
if [[ "$edition" == full ]]; then
  # clean: false 下 dist/ 不会被清，先删掉，不然 artifact 里夹着以前每次的 zip
  rm -rf dist && mkdir dist
else
  mkdir -p dist
fi
ditto -c -k --keepParent "$app" "dist/$name.zip"
# 在 dist 里算，.sha256 里只写文件名，下载解压后直接 `shasum -a 256 -c` 就能核对
(cd dist && shasum -a 256 "$name.zip" | tee "$name.zip.sha256")
# 自动更新包：bundle 自己签的那份不带版本号，app 开着 requireSignedVersion 会拒，用 --app-version 重签
upd="$prefix-$ver-macos-arm64.app.tar.gz"
cp "$bundle/dodoer.app.tar.gz" "dist/$upd"
pnpm tauri signer sign --app-version "$ver" "dist/$upd" >/dev/null
base64 -d < "dist/$upd.sig" | grep -q "version:$ver" || fail "$upd.sig 里没有 version:$ver"
if [[ "$edition" == client ]]; then
  alias="$prefix-macos-arm64.zip"
  cp "dist/$name.zip" "dist/$alias"
  (cd dist && shasum -a 256 "$alias" | tee "$alias.sha256")
  [[ -n "${GITHUB_OUTPUT:-}" ]] && echo "client_alias=$alias" >> "$GITHUB_OUTPUT"
fi
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
