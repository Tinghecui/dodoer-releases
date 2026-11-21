#!/bin/bash
# 编桌面版 dodoer.app（Apple Silicon 和 Intel 各一个包，固定的自签名证书签名），冒烟，打成发布用的文件。跑在公开镜像 desktop-macos.yml 的 macOS 机器上
# （GitHub 托管的，或者黑苹果自托管 runner）。
# 只有一种包：完整版，自带 codeg-server 子进程做本机 daemon；主窗口是开始页，本机工作区和服务器上的工作区都从那里开
# （COWORK.md「桌面端：一种包、开始页」）。2026-11-09 以前还有一种纯客户端版，已经去掉。
#
#   用法：scripts/cowork-desktop-build.sh [full]（参数可省）
#        scripts/cowork-desktop-build.sh smoke：只做冒烟（不编），对象是 dist/ 里已经打好的、本机架构的 dodoer-$VERSION-*-macos-<arm64|x64>.zip。
#          黑苹果（Intel）上交叉编的 arm64 包在那台机器上跑不起来，desktop-macos.yml 把它交给 GitHub 的 macos-15 用这个模式冒烟
#   环境：VERSION（桌面版本号 1.Y.Z）、TAURI_SIGNING_PRIVATE_KEY（+ _PASSWORD）；
#        DODOER_SIGNING_IDENTITY：签 app 的证书（钥匙串里的 SHA-1，desktop-macos.yml 从 Secret DODOER_CODESIGN_P12 导入）。
#        不给就 ad-hoc 签名，只在自己的 Mac 上试编时这样：ad-hoc 的包每一版签名都不同，macOS 的屏幕录制、辅助功能等授权
#        装了新版就失效，所以 CI 里（CI 非空）不给就报错；
#        GITHUB_OUTPUT 有就写 full_name / full_updater
#        DODOER_TARGET：交叉编译的目标（aarch64-apple-darwin 或 x86_64-apple-darwin），不给就编本机架构。给了就 tauri build --target，
#        sidecar 也按它编（TAURI_TARGET_TRIPLE），产物在 src-tauri/target/<目标>/release/bundle
#        DODOER_SKIP_SMOKE=1：不运行包里的程序（交叉编出来的跑不了），只做静态检查；冒烟另用 smoke 模式在 arm64 机器上补
#
# 经 beforeBuildCommand 编前端（out/）和 sidecar（src-tauri/binaries/）。清空 dist/，产物都在 dist/：
# 文件名里的架构：arm64（Apple Silicon）或 x64（Intel，2026-11-16 起）。下面按 arm64 写，x64 一样，只是没有 dodoer-client-* 那个别名
#   dodoer-<ver>-<sha8>-macos-arm64.zip(.sha256)             安装包
#   dodoer-macos-arm64.zip(.sha256)                          同一个文件、名字不带版本（releases/latest/download/… 直接指它）
#   dodoer-client-macos-arm64.zip(.sha256)                   还是同一个文件：门户「桌面版」的下载链接（以前给纯客户端版）指这个名字，留着不让它 404
#   dodoer-<ver>-macos-arm64.app.tar.gz(.sig)                自动更新包  ← latest.json 和 latest-client.json（x64 的 ← latest-x64.json）
# latest.json / latest-client.json 由 workflow 在发布时生成，两个都指这个自动更新包：装过纯客户端版的 app 从 latest-client.json
# 查更新（endpoint 编在它自己的包里），这样它就更新成完整版。
set -euo pipefail

mode="${1:-full}"
edition=full
: "${VERSION:?VERSION=1.Y.Z}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

fail() { echo "::error::$*" >&2; exit 1; }

releases=https://github.com/Tinghecui/dodoer-releases/releases/latest/download
configs=(--config src-tauri/tauri.jenny.conf.json --config src-tauri/tauri.cowork-desktop.conf.json)
[[ "$mode" == full || "$mode" == smoke ]] || fail "不认识的参数 ${mode}：只有 full 和 smoke（纯客户端版 2026-11-09 已经去掉）"
prefix=dodoer
expect_endpoint="$releases/latest.json"
target="${DODOER_TARGET:-}"
case "${target:-$(uname -m)}" in
  aarch64-apple-darwin|arm64) arch=arm64; lipo_arch=arm64 ;;
  x86_64-apple-darwin|x86_64) arch=x64; lipo_arch=x86_64 ;;
  *) fail "DODOER_TARGET 只认 aarch64-apple-darwin、x86_64-apple-darwin，现在是 ${target:-本机 $(uname -m)}" ;;
esac
# Intel 包一天才编一次（desktop-macos-intel.yml），版本跟不上 arm64，latest.json 里放不下（只有一个 version）：
# 它从自己的 latest-x64.json 查更新。写在命令行上，不另加配置文件（check-desktop-editions.mjs 只认 configs=(…) 那一行的文件）
if [[ "$arch" == x64 ]]; then
  expect_endpoint="$releases/latest-x64.json"
  configs+=(--config "{\"plugins\":{\"updater\":{\"endpoints\":[\"$expect_endpoint\"]}}}")
fi
if [[ -n "$target" ]]; then
  bundle="$root/src-tauri/target/$target/release/bundle/macos"
else
  bundle="$root/src-tauri/target/release/bundle/macos"
fi
app="$bundle/dodoer.app"

# 运行包里的程序：自报的版本和更新地址、自带的 codeg-server 子进程。full 模式编完就跑（DODOER_SKIP_SMOKE=1 时跳过），
# smoke 模式对 dist/ 里打好的 zip 跑
smoke_app() {
  local app="$1" exe report server
  exe=$(defaults read "$app/Contents/Info.plist" CFBundleExecutable)
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
  "$app/Contents/MacOS/$exe" --local-daemon-smoke
}

if [[ "$mode" == smoke ]]; then
  zip=$(cd dist && ls "$prefix-$VERSION"-*-macos-$arch.zip 2>/dev/null) || true
  [[ $(printf '%s\n' "$zip" | grep -c .) == 1 ]] || { ls -la dist >&2 || true; fail "dist/ 里 $prefix-$VERSION-*-macos-$arch.zip 要正好一个，现在：${zip:-没有}"; }
  tmp=$(mktemp -d)
  ditto -x -k "dist/$zip" "$tmp"
  test -d "$tmp/dodoer.app" || fail "$zip 里没有 dodoer.app"
  echo "==> [$edition] 冒烟 ${zip}（$(uname -m)）"
  codesign --verify --deep --strict --verbose=2 "$tmp/dodoer.app"
  # 发版安全：包里（程序和 Resources/web 的前端）不能有 e2e 测试版的 WebdriverIO 插件
  bash scripts/check-no-e2e-bits.sh "$tmp/dodoer.app"
  smoke_app "$tmp/dodoer.app"
  rm -rf "$tmp"
  echo "==> [$edition] 冒烟通过：dist/$zip"
  exit 0
fi
identity="${DODOER_SIGNING_IDENTITY:--}"
if [[ "$identity" == - && -n "${CI:-}" ]]; then
  fail "CI 里没给 DODOER_SIGNING_IDENTITY：不能发 ad-hoc 签名的包（装上以后 macOS 授权会失效）"
fi

echo "==> [$edition] tauri build（只出 .app，签名身份 ${identity}，版本 ${VERSION}）"
rm -f "$bundle"/dodoer.app.tar.gz*
rm -rf "$app"
# tauri.cowork-desktop.conf.json 打开自动更新（我们的公钥和 dodoer-releases 的 latest.json），
# createUpdaterArtifacts 让 bundle 里多出 dodoer.app.tar.gz + .sig
target_args=()
if [[ -n "$target" ]]; then
  target_args=(--target "$target")
  # beforeBuildCommand 里的 prepare-sidecars 按它编 sidecar，不然编成本机架构
  export TAURI_TARGET_TRIPLE="$target"
fi
# 签名排队：黑苹果上几个 runner 同时签名会报 errSecInternalComponent（2026-11-16 Intel 包撞上两班 arm64）。tauri 按 PATH
# 找 codesign（tauri-macos-sign 的 Command::new("codesign")），前面垫一个拿锁再调 /usr/bin/codesign 的，一次只签一个。
# 锁和改钥匙串搜索列表的是同一个（desktop-macos.yml），签名时别的 job 也改不了列表。每次几秒，排队几乎不耽误
if [[ "$identity" != - ]] && command -v lockf >/dev/null; then
  signlock=$(mktemp -d)
  printf '#!/bin/bash\nexec lockf -k -t 600 /tmp/dodoer-keychain-list.lock /usr/bin/codesign "$@"\n' > "$signlock/codesign"
  chmod +x "$signlock/codesign"
  export PATH="$signlock:$PATH"
fi
pnpm tauri build --bundles app ${target_args[@]+"${target_args[@]}"} "${configs[@]}" \
  --config "{\"version\":\"$VERSION\",\"bundle\":{\"macOS\":{\"signingIdentity\":\"$identity\"}}}"
test -d "$app" || fail "没编出 $app"
# 包里每个程序都得是这个架构（交叉编译时 sidecar 编错架构就在这里拦下）
for bin in "$app"/Contents/MacOS/*; do
  archs=$(lipo -archs "$bin")
  [[ "$archs" == "$lipo_arch" ]] || fail "$(basename "$bin") 的架构是 ${archs}，要的是 $lipo_arch"
done

echo "==> [$edition] 签名"
codesign --verify --deep --strict --verbose=2 "$app"
# macOS 记授权用的是「指定要求」（designated requirement）：用证书签的是 identifier + 证书哈希，每一版都一样；
# ad-hoc 的是 cdhash，每一版都变。核对它真的指着我们的证书，不然发出去大家的授权又会失效
bundle_id=$(defaults read "$app/Contents/Info.plist" CFBundleIdentifier)
requirement=$(codesign -d -r- "$app" 2>&1 | sed -n 's/^designated => //p')
echo "designated requirement: $requirement"
if [[ "$identity" != - ]]; then
  want=$(tr 'A-F' 'a-f' <<<"$identity")
  [[ "$requirement" == *"identifier \"$bundle_id\""* ]] || fail "指定要求里没有 identifier \"$bundle_id\""
  [[ "$requirement" =~ certificate\ (root|leaf)\ =\ H\"$want\" ]] || fail "指定要求没指着证书 $identity"
  for other in codeg-server codeg-mcp codeg-cli; do
    echo "$other: $(codesign -d -r- "$app/Contents/MacOS/$other" 2>&1 | sed -n 's/^designated => //p')"
  done
fi

echo "==> [$edition] 静态检查"
ver=$(defaults read "$app/Contents/Info.plist" CFBundleShortVersionString)
[[ "$ver" == "$VERSION" ]] || fail "编出来的版本 $ver 不是 $VERSION"
# 「本地网络」权限的说明由 src-tauri/Info.plist 合并进来：没有它，借出的命令行访问局域网会被系统直接拒绝、不弹框
# （docs/host-ssh.md 5.6），所以核对它真的进了包
defaults read "$app/Contents/Info.plist" NSLocalNetworkUsageDescription >/dev/null \
  || fail "包的 Info.plist 里没有 NSLocalNetworkUsageDescription：src-tauri/Info.plist 没合并进来"
server="$app/Contents/MacOS/codeg-server"
test -x "$server" || { ls -la "$app/Contents/MacOS"; fail "$server 不在 bundle 里"; }
[[ $(stat -f %z "$server") -gt 1000000 ]] || fail "$server 是占位文件，prepare-sidecars 没编它"
for other in codeg-mcp codeg-cli; do
  test -x "$app/Contents/MacOS/$other" || fail "$other 不在 bundle 里"
done
# 发版安全：程序和 Resources/web 的前端里不能有 e2e 测试版的 WebdriverIO 插件（cargo feature e2e、NEXT_PUBLIC_CODEG_E2E）
bash scripts/check-no-e2e-bits.sh "$app"
if [[ "${DODOER_SKIP_SMOKE:-}" == 1 ]]; then
  echo "==> [$edition] 冒烟跳过（DODOER_SKIP_SMOKE=1，交叉编译的包在别的机器上用 smoke 模式补）"
else
  echo "==> [$edition] 冒烟"
  smoke_app "$app"
fi

echo "==> [$edition] 打成 zip，自动更新包重签（绑定版本号）"
name="$prefix-$ver-$(git rev-parse --short=8 HEAD)-macos-$arch"
# clean: false 下 dist/ 不会被清，先删掉，不然 artifact 里夹着以前每次的 zip
rm -rf dist && mkdir dist
ditto -c -k --keepParent "$app" "dist/$name.zip"
# 在 dist 里算，.sha256 里只写文件名，下载解压后直接 `shasum -a 256 -c` 就能核对
(cd dist && shasum -a 256 "$name.zip" | tee "$name.zip.sha256")
# 自动更新包：bundle 自己签的那份不带版本号，app 开着 requireSignedVersion 会拒，用 --app-version 重签
upd="$prefix-$ver-macos-$arch.app.tar.gz"
cp "$bundle/dodoer.app.tar.gz" "dist/$upd"
pnpm tauri signer sign --app-version "$ver" "dist/$upd" >/dev/null
base64 -d < "dist/$upd.sig" | grep -q "version:$ver" || fail "$upd.sig 里没有 version:$ver"
# 不带版本号的名字：dodoer-macos-<架构>.zip；arm64 另有门户下载链接用的 dodoer-client-macos-arm64.zip，内容都是这个安装包
aliases=("$prefix-macos-$arch.zip")
[[ "$arch" == arm64 ]] && aliases+=("$prefix-client-macos-arm64.zip")
for alias in "${aliases[@]}"; do
  cp "dist/$name.zip" "dist/$alias"
  (cd dist && shasum -a 256 "$alias" | tee "$alias.sha256")
done
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "${edition}_name=$name" >> "$GITHUB_OUTPUT"
  echo "${edition}_updater=$upd" >> "$GITHUB_OUTPUT"
  echo "arch=$arch" >> "$GITHUB_OUTPUT"
fi
rm -f "$bundle"/dodoer.app.tar.gz*
# 打完包把 bundle 里的 .app 删掉并从 LaunchServices 注销：在自己的 Mac 上跑时，留着的话 Spotlight /
# 「打开方式」里会多出一个 dodoer，codeg:// 链接也可能被它接走。编译缓存在 target/release 别处，不受影响
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$app" || true
rm -rf "$app"
echo "==> [$edition] 完成：dist/$name.zip、dist/$upd"
