#!/bin/bash
# 稳定版晋级（cowork-codeg #410，总览 #409）。公开仓库 Tinghecui/dodoer-releases 的 promote-stable.yml 每小时跑一次。
#
# 稳定版 = 公开仓库里 tag 叫 stable 的那个 Release（预发布，永远不会变成 Latest），里面四个文件：
#   latest.json      稳定版那一版桌面包的更新清单，从 v1.Y.Z 的 Release 原样拷来（签名不变，指向 v1.Y.Z 的包）
#   latest-x64.json  同上，Intel 包的清单（v1.Y.Z 带着的那份；没有就不放）
#   server.json      配对的 server 包 {"tag": "cowork-codeg-v0.Y.Z", "version": "1.Y.Z", "promoted_at": …}，Cowork 的稳定通道读它
#   history.json     {"versions": [{"version", "tag", "server_tag", "promoted_at", "how"}, …]}，新的在前，留 10 个；
#                    app 的「回退到上一版」在稳定通道上从这里挑（cowork-codeg #413）
#
# 自动晋级（不给 VERSION）：
#   - 仓库变量 STABLE_HOLD 是 1 / true：暂停，什么都不做
#   - 上一次晋级不到 GAP_HOURS（24）小时：不做（客户一天最多被更新一次）
#   - 候选：发布满 MIN_AGE_HOURS（24）小时、比现在的稳定版新、server 包也发出来了的桌面版本，新的先看，最多看 5 个，
#     第一个过了闸门的就晋级
#   - 闸门（Sentry，最近 14 天）：
#       要有：抢先版设备在 24 小时以前就换上了它（kind:update update_result:applied update_to:<版本>，cowork-codeg #412）
#       不能有：这一版桌面端的崩溃、卡死、异常退出（surface:desktop-native fatal:true release:dodoer-desktop@<版本>）；
#               换上它失败（update_to:<版本> update_result:install_failed / boot_unconfirmed / rolled_back）；
#               生产服务器上配对的 server 版本 panic（panic in thread …）、计划内重启后对话没接上（could not be resumed，#411）
#   - 没有 SENTRY_TOKEN：不自动晋级（只能手动给 VERSION）
# 手动（给 VERSION，比如 1.6.48）：不看闸门、不看间隔，直接指过去。比现在的稳定版旧也行，这就是撤回
#
#   用法：GH_TOKEN=… [SENTRY_TOKEN=… SENTRY_ORG=…] [VERSION=1.Y.Z] [HOLD=1] [DRY_RUN=1] bash scripts/promote-stable.sh
#   DRY_RUN=1 只打印要做什么，不改 Release
set -euo pipefail

REPO=${GITHUB_REPOSITORY:-Tinghecui/dodoer-releases}
STABLE=stable
MIN_AGE_HOURS=${MIN_AGE_HOURS:-24}
GAP_HOURS=${GAP_HOURS:-24}
KEEP_HISTORY=10
MAX_CANDIDATES=5
VERSION=${VERSION:-}
HOLD=${HOLD:-}
DRY_RUN=${DRY_RUN:-}
SENTRY_TOKEN=${SENTRY_TOKEN:-}
SENTRY_ORG=${SENTRY_ORG:-}
SENTRY_API=${SENTRY_API:-https://sentry.io/api/0}

say() { echo "$*"; if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$*" >> "$GITHUB_STEP_SUMMARY"; fi; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
now=$(date -u +%s)
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }
# 版本比较：a 比 b 新
newer() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; }

# ---- 现在的稳定版 ----
stable_exists=false
if gh release view "$STABLE" -R "$REPO" --json tagName >/dev/null 2>&1; then
  stable_exists=true
  gh release download "$STABLE" -R "$REPO" -p history.json -D "$tmp/cur" >/dev/null 2>&1 || true
fi
[ -f "$tmp/cur/history.json" ] || { mkdir -p "$tmp/cur" && echo '{"versions": []}' > "$tmp/cur/history.json"; }
cur=$(jq -r '.versions[0].version // empty' "$tmp/cur/history.json")
cur_at=$(jq -r '.versions[0].promoted_at // empty' "$tmp/cur/history.json")
say "现在的稳定版：${cur:-（还没有）}${cur_at:+，$cur_at 晋级}"

# ---- 发出来的版本：tag 和发布时间（不含草稿、预发布）----
gh api --paginate "repos/$REPO/releases?per_page=100" \
  --jq '.[] | select((.draft or .prerelease) | not) | "\(.tag_name) \(.published_at)"' > "$tmp/releases.txt"
published_at() { awk -v t="$1" '$1 == t { print $2; exit }' "$tmp/releases.txt"; }
# 桌面 1.Y.Z 配 server 0.Y.Z（release-train 一班两个包同号；server 包没发出来的那班没有配对，不能当稳定版）
server_of() { echo "cowork-codeg-v0.${1#1.}"; }

# ---- 闸门 ----
# Sentry 的 Discover：count()。查不到（令牌不对、查询写错、Sentry 出问题）输出 failed，闸门当作没过，不当作 0
sentry_count() {
  local query=$1; shift
  curl -sSf -G --max-time 30 -H "Authorization: Bearer $SENTRY_TOKEN" "$SENTRY_API/organizations/$SENTRY_ORG/events/" \
    --data-urlencode "dataset=errors" --data-urlencode "field=count()" --data-urlencode "query=$query" "$@" \
    | jq -r '.data[0]["count()"] // 0' || echo failed
}
reason=""
# 一条检查：want 是 some（要有）或 none（不能有）；不满足时 reason 写上 why（$n 换成次数）
check() {
  local want=$1 why=$2 query=$3 n; shift 3
  n=$(sentry_count "$query" "$@")
  [[ "$n" =~ ^[0-9]+$ ]] || { reason="查 Sentry 失败（$query）"; return 1; }
  if { [ "$want" = some ] && [ "$n" -eq 0 ]; } || { [ "$want" = none ] && [ "$n" -gt 0 ]; }; then
    reason=${why//\$n/$n}; return 1
  fi
}
gate() {
  local v=$1 s window=(--data-urlencode "statsPeriod=14d")
  s=$(server_of "$v")
  check some "还没有设备在 ${MIN_AGE_HOURS} 小时以前换上它（抢先版没人在跑？）" \
    "project:codeg-web surface:desktop-native kind:update update_result:applied update_to:$v" \
    --data-urlencode "start=$(iso $((now - 14 * 86400)))" --data-urlencode "end=$(iso $((now - MIN_AGE_HOURS * 3600)))" || return 1
  check none "桌面端崩溃、卡死或异常退出 \$n 次" \
    "project:codeg-web surface:desktop-native fatal:true release:dodoer-desktop@$v" "${window[@]}" || return 1
  check none "换上它失败 \$n 次" \
    "project:codeg-web surface:desktop-native kind:update update_to:$v update_result:[install_failed,boot_unconfirmed,rolled_back]" "${window[@]}" || return 1
  check none "生产服务器上 $s panic \$n 次" \
    "project:codeg-server environment:production release:$s message:\"panic in thread*\"" "${window[@]}" || return 1
  check none "生产服务器上 $s 计划内重启后有对话没接上（\$n 次）" \
    "project:codeg-server environment:production release:$s message:\"*could not be resumed*\"" "${window[@]}" || return 1
  reason=""
}

# ---- 挑版本 ----
how=""
if [ -n "$VERSION" ]; then
  VERSION=${VERSION#v}
  [[ "$VERSION" =~ ^1\.[0-9]+\.[0-9]+$ ]] || { say "::error::版本号不对：$VERSION（要像 1.6.48）"; exit 1; }
  [ -n "$(published_at "v$VERSION")" ] || { say "::error::没有 v$VERSION 这个 Release"; exit 1; }
  [ -n "$(published_at "$(server_of "$VERSION")")" ] || { say "::error::$(server_of "$VERSION") 没有发出来，不能当稳定版"; exit 1; }
  [ "$VERSION" != "$cur" ] || { say "稳定版就是 $VERSION，不用改"; exit 0; }
  pick=$VERSION; how=manual
  say "手动指定：$pick（不看闸门）"
else
  case "$HOLD" in 1 | true) say "暂停着（仓库变量 STABLE_HOLD=$HOLD），不晋级"; exit 0 ;; esac
  if [ -n "$cur_at" ] && [ $((now - $(date -u -d "$cur_at" +%s))) -lt $((GAP_HOURS * 3600)) ]; then
    say "上一次晋级不到 ${GAP_HOURS} 小时，不晋级"; exit 0
  fi
  [ -n "$SENTRY_TOKEN" ] && [ -n "$SENTRY_ORG" ] || { say "没有 Sentry 令牌（secret SENTRY_READ_TOKEN、变量 SENTRY_ORG），不自动晋级；要晋级就手动给版本号"; exit 0; }
  cutoff=$((now - MIN_AGE_HOURS * 3600))
  candidates=$(awk '$1 ~ /^v1\.[0-9]+\.[0-9]+$/ { print }' "$tmp/releases.txt" | while read -r t at; do
      v=${t#v}
      [ "$(date -u -d "$at" +%s)" -le "$cutoff" ] || continue
      [ -z "$cur" ] || newer "$v" "$cur" || continue
      [ -n "$(published_at "$(server_of "$v")")" ] || continue
      echo "$v"
    done | sort -rV | head -n "$MAX_CANDIDATES")
  [ -n "$candidates" ] || { say "没有发布满 ${MIN_AGE_HOURS} 小时、比稳定版新、server 包也发了的版本"; exit 0; }
  pick=""
  for v in $candidates; do
    if gate "$v"; then pick=$v; break; fi
    say "- $v 不晋级：$reason"
  done
  [ -n "$pick" ] || { say "这一轮没有版本过闸门"; exit 0; }
  how=auto
  say "过了闸门：$pick"
fi

# ---- 拼出新的四个文件 ----
server=$(server_of "$pick")
at=$(iso "$now")
mkdir -p "$tmp/new"
gh release download "v$pick" -R "$REPO" -p latest.json -D "$tmp/new" >/dev/null
[ "$(jq -r .version "$tmp/new/latest.json")" = "$pick" ] || { say "::error::v$pick 的 latest.json 里版本不是 $pick"; exit 1; }
gh release download "v$pick" -R "$REPO" -p latest-x64.json -D "$tmp/new" >/dev/null 2>&1 || true
jq -n --arg tag "$server" --arg version "$pick" --arg at "$at" '{tag: $tag, version: $version, promoted_at: $at}' > "$tmp/new/server.json"
jq --arg v "$pick" --arg server "$server" --arg at "$at" --arg how "$how" --argjson keep "$KEEP_HISTORY" \
  '.versions = ([{version: $v, tag: ("v" + $v), server_tag: $server, promoted_at: $at, how: $how}]
                 + [.versions[] | select(.version != $v)])[:$keep]' "$tmp/cur/history.json" > "$tmp/new/history.json"

notes="稳定版：现在是 dodoer $pick（桌面包 v$pick，server 包 $server），$at $([ "$how" = auto ] && echo 自动晋级 || echo 手动指定)。

app 的稳定通道从这里的 latest.json 更新，Cowork 的稳定通道读 server.json。由 promote-stable.yml 维护（cowork-codeg #410），不要手动改。"
if [ -n "$DRY_RUN" ]; then
  say "（DRY_RUN）要把 $STABLE 指到 $pick："; for f in "$tmp"/new/*.json; do echo "== $(basename "$f")"; jq -c . "$f" | head -c 400; echo; done
  exit 0
fi
if [ "$stable_exists" = false ]; then
  # 预发布：永远不会被当成 Latest（app 的抢先通道读 releases/latest）
  gh release create "$STABLE" -R "$REPO" --prerelease --latest=false --target "$(gh api "repos/$REPO/commits/v$pick" --jq .sha)" \
    --title "dodoer 稳定版" --notes "$notes" "$tmp"/new/*.json
else
  gh release upload "$STABLE" -R "$REPO" --clobber "$tmp"/new/*.json
  [ -f "$tmp/new/latest-x64.json" ] || gh release delete-asset "$STABLE" latest-x64.json -R "$REPO" --yes 2>/dev/null || true
  gh release edit "$STABLE" -R "$REPO" --notes "$notes" >/dev/null
fi
say "✓ 稳定版指到了 $pick（$server）"
