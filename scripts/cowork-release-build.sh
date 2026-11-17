#!/bin/bash
# Build the Cowork Linux x64 server artifact in containers on the CI host
# (rootless docker of the runner user; never the system docker), or anywhere
# with COWORK_DOCKER set to the docker command to use (GitHub Actions:
# .github/workflows/cowork-release.yml sets COWORK_DOCKER=docker).
#
#   usage (as root on ci):  COWORK_VERSION=cowork-codeg-vX.Y.Z bash cowork-release-build.sh <build-dir> [frontend|backend|package|all]
#
# <build-dir> is an rsync'ed copy of this repo owned by gha-runner, e.g.
# /data/gha-runner/cowork-codeg-build/release. Output:
#   <build-dir>/dist/cowork-codeg-server-linux-x64.tar.gz (+ .sha256)
# containing codeg-server, codeg-mcp, codeg-cli, web/, LICENSE, COWORK-VERSION,
# ACP-ADAPTERS, DB-MIGRATIONS, SERVER-REV at the top level (extract straight into
# /usr/local/lib/cowork-codeg).
# codeg-server puts the directory it runs from first on the PATH of its
# terminals and agents when codeg-cli is there (cli_run::shim::plan_server).
# GitHub Actions builds the binaries itself (.github/public/workflows/
# cowork-release.yml, backend job) and only runs the package step here.
set -euo pipefail

DIR=${1:?usage: $0 <build-dir> [frontend|backend|package|all]}
STEP=${2:-all}
NAME=cowork-codeg-server-linux-x64
if [ -n "${COWORK_DOCKER:-}" ]; then
  read -ra D <<<"$COWORK_DOCKER"
  own() { :; }
else
  D=(sudo -u gha-runner XDG_RUNTIME_DIR=/run/user/1000 DOCKER_HOST=unix:///run/user/1000/docker.sock docker)
  own() { chown -R gha-runner:gha-runner "$@"; }
fi
cd /tmp

frontend() {
  # Same as the upstream Dockerfile stage 1 (static export to out/), on
  # node:24-bookworm. Rootless docker has no cpu cgroup: only --memory works.
  "${D[@]}" run --rm --name cowork-codeg-release-fe --memory 6g \
    -v "$DIR":/app -v cowork-codeg-pnpm-store:/pnpm-store -v cowork-codeg-fe-nm:/app/node_modules \
    -e CI=true -e NEXT_TELEMETRY_DISABLED=1 -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    -e NODE_OPTIONS=--max-old-space-size=4096 -e COWORK_VERSION="${COWORK_VERSION:-}" \
    -w /app node:24-bookworm bash -c \
    'corepack enable >/dev/null 2>&1 && pnpm config set store-dir /pnpm-store >/dev/null &&
     pnpm install --frozen-lockfile && rm -rf out && pnpm build && test -f out/index.html'
}

backend() {
  # Same as the upstream Dockerfile stage 2, on rust:slim-bookworm (glibc 2.36).
  "${D[@]}" run --rm --name cowork-codeg-release-be -e CARGO_BUILD_JOBS=4 \
    -v "$DIR":/app -v cowork-codeg-cargo:/usr/local/cargo/registry \
    -v cowork-codeg-target-release:/app/src-tauri/target -v cowork-codeg-rustup-backend:/usr/local/rustup \
    -w /app/src-tauri rust:slim-bookworm bash -c \
    'apt-get update -qq && apt-get install -y -qq pkg-config libssl-dev >/dev/null &&
     cargo build --release --bin codeg-server --no-default-features --features server-bin &&
     cargo build --release --bin codeg-mcp --no-default-features --features mcp-bin &&
     cargo build --release --bin codeg-cli --no-default-features --features cli-bin &&
     mkdir -p /app/dist/bin && cp target/release/codeg-server target/release/codeg-mcp target/release/codeg-cli /app/dist/bin/ &&
     strip /app/dist/bin/codeg-server /app/dist/bin/codeg-mcp /app/dist/bin/codeg-cli'
}

# 编 codeg-server 用到的源码的指纹，40 位十六进制，前面带算法版本 v1-：
# - src-tauri/ 整个目录的 git tree（代码、Cargo.toml、Cargo.lock、build.rs、resources/）；
# - rust-toolchain.toml、编它的 workflow（公开仓库里是 .github/workflows/cowork-release.yml，编译开关在那里）；
# - src-tauri 里 include_str! / include_bytes! 引到目录外面的文件（src/browser-injected/*.js 这些）。文件末尾
#   `#[cfg(test)]` + 顶格 `mod … {` 之后引的只给测试用，不算（不然测试引的 src/i18n/messages/en.json 一改界面文字就要重启）。
# 宁可多算：只改了桌面专用的 Rust 也算变了。算法改了就换前缀（v2-），新旧两种永远对不上，最坏是多重启一次
server_rev() {
  git -C "$DIR" rev-parse -q --verify HEAD >/dev/null 2>&1 || return 0
  local p h
  {
    echo "src-tauri $(git -C "$DIR" rev-parse HEAD:src-tauri)"
    for p in rust-toolchain.toml .github/workflows/cowork-release.yml $(included_outside); do
      h=$(git -C "$DIR" rev-parse -q --verify "HEAD:$p" 2>/dev/null) || h=missing
      echo "$p $h"
    done
  } | sha256sum | cut -c1-40 | sed 's/^/v1-/'
}

# src-tauri/**/*.rs 里 include_str!("…") / include_bytes!("…") 指到 src-tauri 外面的文件，相对仓库根的路径，去重排序
included_outside() {
  local file line rel target tests
  (cd "$DIR" && grep -rnoE --include='*.rs' 'include_(str|bytes)!\("[^"]+"\)' src-tauri) | while IFS=: read -r file line rel; do
    # 测试模块从哪一行开始：顶格的 #[cfg(test)]，下一行是顶格的 mod
    tests=$(awk 'prev ~ /^#\[cfg\(test\)\]/ && /^(pub(\([a-z]+\))? )?mod [a-z_0-9]+ *\{/ { print NR; exit } { prev = $0 }' "$DIR/$file")
    [ -n "$tests" ] && [ "$line" -gt "$tests" ] && continue
    rel=${rel#*\(\"}; rel=${rel%\"\)}
    target=$(realpath -m --relative-to="$DIR" "$DIR/$(dirname "$file")/$rel")
    case "$target" in src-tauri/* | ../*) ;; *) echo "$target" ;; esac
  done | sort -u
}

package() {
  local stage="$DIR/dist/$NAME"
  rm -rf "$stage" "$DIR/dist/$NAME.tar.gz" "$DIR/dist/$NAME.tar.gz.sha256"
  mkdir -p "$stage"
  install -m 755 "$DIR/dist/bin/codeg-server" "$DIR/dist/bin/codeg-mcp" "$DIR/dist/bin/codeg-cli" "$stage/"
  # out/ 和 dist/bin 可能是容器里 root 写出来的；这里可能不是 root（GitHub Actions），不要保留属主
  cp -a --no-preserve=ownership "$DIR/out" "$stage/web"
  cp "$DIR/LICENSE" "$stage/"
  echo "${COWORK_VERSION:-unknown}" > "$stage/COWORK-VERSION"
  # Cowork 从门户单独换 codeg 版本时按这两个文件办事（Tinghecui/cowork 的 deploy/server/）：
  # ACP-ADAPTERS 是这一版 registry.rs 钉的 ACP 适配器，一行一个 acp-<命令>=<版本>，和 cowork 的 runtime.lock 同格式，
  # cowork 照它给所有员工全局装适配器；DB-MIGRATIONS 是这一版认的数据库迁移，一行一个（就是 seaql_migrations 里记的名字），
  # 换回这一版时员工的库里要是有它不认的迁移，它起不来，cowork 就把库换回快照。
  sed -n -E 's|^ *package: "@agentclientprotocol/([a-z0-9-]+)@([0-9][^"]*)",.*|acp-\1=\2|p' \
    "$DIR/src-tauri/src/acp/registry.rs" | sort -u > "$stage/ACP-ADAPTERS"
  grep -oE 'Box::new\(m[0-9]{8}_[0-9]{6}_[a-z0-9_]+::Migration\)' "$DIR/src-tauri/src/db/migration/mod.rs" \
    | sed -E 's/^Box::new\(([^:]+)::Migration\)$/\1/' > "$stage/DB-MIGRATIONS"
  grep -q '^acp-claude-agent-acp=' "$stage/ACP-ADAPTERS" && grep -q '^acp-codex-acp=' "$stage/ACP-ADAPTERS" \
    || { echo "ACP-ADAPTERS 里没有 claude-agent-acp 或 codex-acp（registry.rs 的写法变了？）" >&2; exit 1; }
  [ -s "$stage/DB-MIGRATIONS" ] || { echo "DB-MIGRATIONS 是空的（db/migration/mod.rs 的写法变了？）" >&2; exit 1; }
  # SERVER-REV：服务端程序的源码指纹（cowork-codeg #410）。两个版本的指纹一样 = 编出 codeg-server 的源码一个字没变，
  # Cowork 换 codeg 时只叫跑着的 daemon 换网页文件（cowork_reload_web，web/static_assets.rs 也要两边一样才肯换），不重启。
  # 不是 git 仓库（拿不到指纹）就不写：缺这个文件的版本一律按要重启处理
  local rev
  rev=$(server_rev)
  if [ -n "$rev" ]; then echo "$rev" > "$stage/SERVER-REV"; else echo "注意：不是 git 仓库，包里没有 SERVER-REV（换上它的 daemon 都要重启）" >&2; fi
  (cd "$stage" && tar --owner=0 --group=0 --numeric-owner -czf "../$NAME.tar.gz" .)
  (cd "$DIR/dist" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
  own "$DIR/dist"
  cat "$DIR/dist/$NAME.tar.gz.sha256"
}

own "$DIR"
case "$STEP" in
  frontend) frontend ;;
  backend) backend ;;
  package) package ;;
  all) frontend && backend && package ;;
  *) echo "unknown step: $STEP" >&2; exit 2 ;;
esac
