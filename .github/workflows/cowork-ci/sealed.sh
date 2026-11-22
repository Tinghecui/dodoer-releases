#!/bin/bash
# 在公开仓库 Tinghecui/dodoer-releases 的机器上跑私有仓库 Tinghecui/cowork 的测试或打包（cowork-test.yml、cowork-bundle.yml 调）。
# 设计见 cowork 仓库 .cowork/journal/2026-11-22-cowork-ci-public-runners.md。
#
# 公开仓库的日志谁都能看，所以：
# - 克隆、测试、打包的全部输出进 $W/out/<步骤>.log；公开日志（fd 3）里只有 COWORK-BEGIN、每个阶段一行不带名字的进度、COWORK-END rc=<n>。
#   跑 cowork 代码的命令拿不到 fd 3。ai-qa-seal.yml 在运行结束后按这个格式逐行核对（cowork-codeg 的 .cowork/ai-qa/seal-check.sh）。
# - 这个脚本在公开仓库里（cowork-codeg 同步过来），不用 cowork 自己的：PR 改不了封口。
# - 这一步只有只读令牌。日志由后面的 report.sh 传到 cowork 的 Release「ci-logs」，结果打成 commit status。
#
# 用法：sealed.sh <unit|linux|bundle>
# 环境：W（工作目录）、SHA（要测的提交，40 位）、PR（可选：按 SHA 取不到时退回 refs/pull/<PR>/merge）、
#       COWORK_TOKEN（只读：cowork；打包时还能读 cowork-runtime 的 Release）、VERSION（bundle）、
#       TOOLS_SHA（可选，bundle：被测的老提交里还没有 deploy/ci/bundle.sh 时，用这个提交里的那份，发版预演用）
set -uo pipefail

MODE=${1:-}
case "$MODE" in unit | linux | bundle) ;; *) echo "用法：sealed.sh <unit|linux|bundle>"; exit 2 ;; esac
: "${W:?}" "${SHA:?}"
mkdir -p "$W/out" "$W/st"
rm -f "$W/st/rc-$MODE"

exec 3>&1
exec > "$W/out/$MODE.log" 2>&1
pub() { echo "$*" >&3; }
pub "COWORK-BEGIN"

# 这次跑出来的进程都带这个标记（环境变量会继承），收尾时按它清掉残留，后面传日志、打 status 的那一步才换写令牌
COWORK_CI_MARK=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
export COWORK_CI_MARK

n=0
# stage <名字> <命令…>：名字只进私有的日志，公开日志里是「[序号] 时间 完成/失败（退出码），用时」（seal-check.sh 认的格式）
stage() {
  n=$((n + 1))
  local name=$1 t0=$SECONDS rc d now
  shift
  echo "=== [$n] $name（$(date -u +%FT%TZ)）"
  "$@" 3>&-
  rc=$?
  d=$((SECONDS - t0)); now=$(date -u +%H:%M:%S)
  if ((rc == 0)); then
    pub "[$n] $now 完成，$((d / 60)) 分 $((d % 60)) 秒"
  else
    echo "=== [$n] $name 失败（退出码 $rc）"
    pub "[$n] $now 失败（退出码 $rc），$((d / 60)) 分 $((d % 60)) 秒"
  fi
  return $rc
}

auth() { printf 'AUTHORIZATION: basic %s' "$(printf 'x-access-token:%s' "$COWORK_TOKEN" | base64 -w0)"; }
URL=https://github.com/Tinghecui/cowork.git

clone() {
  rm -rf "$W/src" && git init -q "$W/src" && cd "$W/src" || return 1
  # 令牌走请求头，不进 URL、不进 .git/config（git 报错时会把 URL 打出来）
  if ! git -c http.extraHeader="$(auth)" fetch -q "$URL" "$SHA"; then
    [[ "${PR:-}" =~ ^[0-9]+$ ]] || return 1
    echo "按 SHA 取不到（PR 又推了新提交？），改取 refs/pull/$PR/merge"
    git -c http.extraHeader="$(auth)" fetch -q "$URL" "refs/pull/$PR/merge" || return 1
  fi
  git checkout -q --detach FETCH_HEAD || return 1
  echo "被测：$(git rev-parse HEAD)（要的是 $SHA）"
  if [[ "$MODE" == bundle && ! -f deploy/ci/bundle.sh && -n "${TOOLS_SHA:-}" ]]; then
    git -c http.extraHeader="$(auth)" fetch -q "$URL" "$TOOLS_SHA" && git show FETCH_HEAD:deploy/ci/bundle.sh > "$W/st/bundle.sh" || return 1
    echo "deploy/ci/bundle.sh 用 ${TOOLS_SHA::9} 的"
  fi
}

unit() {
  # tests/core/codeg-unit-stop.test.ts 要 systemd 用户实例（同 cowork 的 test.yml）；起不来那一条自己跳过
  if sudo -n loginctl enable-linger "$(id -un)"; then
    for _ in $(seq 40); do [ -S "/run/user/$(id -u)/bus" ] && break; sleep 0.25; done
  fi
  npm test
}

linux() { npm run test:container; }

bundle() {
  local s=deploy/ci/bundle.sh
  [[ -f $s ]] || s=$W/st/bundle.sh
  [[ -f $s ]] || { echo "被测的提交里没有 deploy/ci/bundle.sh"; return 1; }
  GH_TOKEN="$COWORK_TOKEN" bash "$s" all --out "$W/dist" --version "${VERSION:?}" || return 1
  # Release 的说明：CHANGELOG.md 里这个版本的那一节（同 cowork 的 release.yml 的 publish），没有就空着，发的时候兜底
  awk -v h="## $VERSION（" 'index($0, h) == 1 { on = 1; next } on && /^## / { exit } on' CHANGELOG.md | sed -e '/./,$!d' > "$W/st/notes.md"
}

# 收尾：docker 容器、带标记的残留进程（测试起的后台进程）
cleanup() {
  docker ps -aq 2>/dev/null | xargs -r docker rm -f > /dev/null 2>&1
  local p pid
  for p in /proc/[0-9]*; do
    pid=${p#/proc/}
    [[ "$pid" == "$$" || "$pid" == "$BASHPID" ]] && continue
    if tr '\0' '\n' < "$p/environ" 2> /dev/null | grep -qxF "COWORK_CI_MARK=$COWORK_CI_MARK"; then kill -9 "$pid" 2> /dev/null; fi
  done
  return 0
}

rc=0
stage clone clone || rc=$?
if ((rc == 0)); then
  cd "$W/src" || rc=1
  # 测试用不着令牌，不传给它（打包要用它下载 cowork-runtime 的包）
  [[ "$MODE" == bundle ]] || unset COWORK_TOKEN
  case "$MODE" in
    unit) stage "npm test" unit || rc=$? ;;
    linux) stage "npm run test:container" linux || rc=$? ;;
    bundle) stage "打包、装一遍" bundle || rc=$? ;;
  esac
fi
cd "$W" || true
stage cleanup cleanup || true

echo "$rc" > "$W/st/rc-$MODE"
pub "COWORK-END rc=$rc"
exit "$rc"
