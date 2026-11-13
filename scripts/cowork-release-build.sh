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
# containing codeg-server, codeg-mcp, codeg-cli, web/, LICENSE, COWORK-VERSION
# at the top level (extract straight into /usr/local/lib/cowork-codeg).
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

package() {
  local stage="$DIR/dist/$NAME"
  rm -rf "$stage" "$DIR/dist/$NAME.tar.gz" "$DIR/dist/$NAME.tar.gz.sha256"
  mkdir -p "$stage"
  install -m 755 "$DIR/dist/bin/codeg-server" "$DIR/dist/bin/codeg-mcp" "$DIR/dist/bin/codeg-cli" "$stage/"
  # out/ 和 dist/bin 可能是容器里 root 写出来的；这里可能不是 root（GitHub Actions），不要保留属主
  cp -a --no-preserve=ownership "$DIR/out" "$stage/web"
  cp "$DIR/LICENSE" "$stage/"
  echo "${COWORK_VERSION:-unknown}" > "$stage/COWORK-VERSION"
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
