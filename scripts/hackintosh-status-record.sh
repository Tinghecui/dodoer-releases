#!/bin/bash
# 给黑苹果状态页记一条数：往公开仓库 hackintosh-status 分支的 <种类>/<UTC 日期>.jsonl 末尾加一行，只留最近 8 天。
# hackintosh-heartbeat.yml 每 10 分钟调两次（host：beat 在黑苹果上采的负载、内存、磁盘；queue：3 个 runner 各在跑什么、
# 几个活在排队），状态页（.github/public/status-page/，hackintosh-status-pages.yml 发布）从 raw.githubusercontent.com 读。
#
#   用法：scripts/hackintosh-status-record.sh <host|queue> '<一行 JSON>'
#   环境：GH_TOKEN（contents: write）、GITHUB_REPOSITORY
#
# 分支只放数，历史没用：每天第一次写的时候压成一个提交（force-with-lease，和另一种同时写的撞了就重来）。
# host 和 queue 写不同的文件，撞了重新取一次再加就行，最多试 5 次
set -euo pipefail

kind="$1" line="$2"
[[ "$kind" == host || "$kind" == queue ]] || { echo "::error::种类只有 host、queue，现在是 $kind" >&2; exit 1; }
jq -e . >/dev/null <<<"$line" || { echo "::error::不是 JSON：$line" >&2; exit 1; }
: "${GH_TOKEN:?}" "${GITHUB_REPOSITORY:?}"

branch=hackintosh-status
url="${STATUS_REMOTE:-https://github.com/$GITHUB_REPOSITORY}" # STATUS_REMOTE：本地试的时候指一个裸仓库
auth="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')"
day=$(date -u +%F)
oldest=$(date -u -d '7 days ago' +%F)
g() { git -c http.extraheader="$auth" "$@"; }

for attempt in 1 2 3 4 5; do
  work=$(mktemp -d)
  cd "$work"
  git init -q
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  tip=""
  if g fetch -q --depth=1 "$url" "$branch" 2>/dev/null; then
    tip=$(git rev-parse FETCH_HEAD)
    git checkout -q -B data "$tip"
  else
    git checkout -q --orphan data
  fi
  mkdir -p "$kind"
  printf '%s\n' "$(jq -c . <<<"$line")" >> "$kind/$day.jsonl"
  for f in host/*.jsonl queue/*.jsonl; do
    [[ -f "$f" ]] || continue
    d=$(basename "$f" .jsonl)
    if [[ "$d" < "$oldest" ]]; then rm -f "$f"; fi
  done
  git add -A
  # 今天第一次写（上一个提交是昨天的）：不接在上面，压成一个新的根提交
  if [[ -n "$tip" && $(TZ=UTC git log -1 --format=%cd --date=format-local:%F "$tip") == "$day" ]]; then
    git commit -q -m "$kind $(date -u +%FT%TZ)"
    lease=()
  else
    tree=$(git write-tree)
    git reset -q --soft "$(git commit-tree "$tree" -m "$day 起的数（$kind $(date -u +%FT%TZ)）")"
    lease=(--force-with-lease="refs/heads/$branch:${tip}")
  fi
  if g push -q ${lease[@]+"${lease[@]}"} "$url" "HEAD:refs/heads/$branch"; then
    echo "记下了 $kind/$day.jsonl（第 $attempt 次）"
    exit 0
  fi
  echo "::warning::推送 $branch 没成（第 $attempt 次，多半是和另一条同时写），重来"
  cd /; rm -rf "$work"
  sleep $((attempt * 3))
done
echo "::error::5 次都没推上 $branch" >&2
exit 1
