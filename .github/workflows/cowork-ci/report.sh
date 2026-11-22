#!/bin/bash
# cowork-test.yml、cowork-bundle.yml 的最后一步（不跑 cowork 的代码，只跑这里的脚本）：把这台机器上的日志（$W/out）打包传到
# 私有仓库 Tinghecui/cowork 的 Release「ci-logs」（prerelease、不设 latest，附件留 7 天），再给被测的提交打 commit status「公开 CI / <名字>」，
# 链接指向那个附件（只有能看 cowork 的人打得开）。公开日志里同样只有 COWORK-BEGIN / COWORK-END。
#
# 用法：report.sh <名字> <步骤> [<步骤>…]
#   名字：status 的 context 后半（unit、linux、bundle、publish）
#   步骤：看哪几个 $W/st/rc-<步骤>。第一个没有 = 没跑完（取消、机器断了），status 是 error；后面的没有就不算
# 环境：W、SHA、HEAD_SHA（打 status 的提交，PR 头；空就不打）、GH_TOKEN（cowork 的 contents: write + statuses: write）
set -uo pipefail

NAME=${1:?}; shift
[[ "$NAME" =~ ^[a-z]+$ ]] || { echo "名字不对"; exit 2; }
: "${W:?}" "${SHA:?}"
mkdir -p "$W/out" "$W/st"
LOG="$W/st/report-$NAME.log"

exec 3>&1
exec >> "$LOG" 2>&1
pub() { echo "$*" >&3; }
pub "COWORK-BEGIN"

REPO=Tinghecui/cowork
REL=ci-logs

rc=""
first=1
for m in "$@"; do
  f="$W/st/rc-$m"
  if [[ -f "$f" ]]; then
    r=$(tr -dc 0-9 < "$f")
    if [[ -z "$rc" || "$rc" == 0 ]]; then rc=${r:-1}; fi
  elif ((first)); then
    rc=none
  fi
  first=0
done
echo "结果：${rc}（$*）"

ASSET="cowork-ci-$NAME-${SHA::9}-${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-1}.tar.zst"
url=""
upload() {
  cp "$LOG" "$W/out/report-$NAME.log" 2> /dev/null
  tar -C "$W" --zstd -cf "$W/$ASSET" out || return 1
  if ! gh release view "$REL" -R "$REPO" > /dev/null 2>&1; then
    # unit、linux 两个 job 第一次同时来建，后建的那个失败没关系
    gh release create "$REL" -R "$REPO" --prerelease --latest=false --target main --title "CI 日志" \
      --notes "公开仓库 dodoer-releases 上跑的 cowork 测试、打包、发布的日志（那边 .github/workflows/cowork-ci/report.sh 传上来的），附件留 7 天。不是发版：prerelease 不会被 /releases/latest 取到，cowork upgrade 和客户都看不到。" \
      || sleep 5
  fi
  local i
  for i in 1 2 3; do
    gh release upload "$REL" "$W/$ASSET" -R "$REPO" --clobber && break
    ((i == 3)) && return 1
    sleep $((i * 10))
  done
  url="https://github.com/$REPO/releases/download/$REL/$ASSET"
  # 超过 7 天的附件删掉；删不掉不算失败
  local old
  old=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)
  gh api "repos/$REPO/releases/tags/$REL" -q ".assets[] | select((.name | startswith(\"cowork-ci-\")) and .created_at < \"$old\") | .id" \
    | while read -r id; do gh api -X DELETE "repos/$REPO/releases/assets/$id" > /dev/null || true; done
  return 0
}
ok=0
upload || { ok=1; pub "COWORK-UPLOAD-FAILED"; }

if [[ "${HEAD_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
  case "$rc" in
    0) state=success desc="通过" ;;
    none) state=error desc="没跑完（取消了，或机器断了）" ;;
    *) state=failure desc="没通过（退出码 $rc）" ;;
  esac
  [[ -n "$url" ]] && desc="$desc，日志点详情（私有附件）" || desc="$desc，日志没传上去"
  jq -n --arg s "$state" --arg d "$desc" --arg c "公开 CI / $NAME" --arg u "$url" \
    '{state: $s, description: $d, context: $c} + (if $u == "" then {} else {target_url: $u} end)' \
    | gh api -X POST "repos/$REPO/statuses/$HEAD_SHA" --input - > /dev/null || ok=1
fi

pub "COWORK-END rc=$ok"
exit "$ok"
