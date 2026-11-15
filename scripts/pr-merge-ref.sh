#!/bin/bash
# PR 同步到公开仓库时测哪份代码：GitHub 合出来的「最新 product + 这个 PR」（refs/pull/<n>/merge），合并以后 product 上就是这份。
# 以前同步的是 PR 自己的头提交，两个各自绿的 PR 合在一起可能就红了，要等合并后 product 上的 Test 才知道（COWORK.md「合并：auto-merge 和 product 的 ruleset」）。
# 合并提交是 GitHub 在后台算的，product 刚动过时可能还是按旧的 product 合的：看它的第一个父提交是不是 base 现在的头，
# 不是就请 GitHub 重算（读一次 PR 的 mergeable）再等一会儿；第二个父提交必须是 PR 头。
# 合不出来（有冲突，这种 PR 本来也合不进去）就退回 PR 头提交，和以前一样。
#
#   用法：scripts/pr-merge-ref.sh <PR 号> <PR 头 sha> <base 分支>      输出要同步的提交（在本地仓库里，可以直接 git archive）
#   环境：GH_TOKEN、GITHUB_REPOSITORY（读 PR 的 mergeable）；git 的 origin 能 fetch（actions/checkout 留下的凭据）
set -euo pipefail

pr="${1:?PR 号}" head="${2:?PR 头 sha}" base="${3:?base 分支}"
tries="${PR_MERGE_TRIES:-4}" wait="${PR_MERGE_WAIT:-5}"
ref=refs/remotes/origin/pr-merge
want=$(git ls-remote origin "refs/heads/$base" | cut -f1)
[[ -n "$want" ]] || { echo "::warning::读不到 $base 的头提交，按 PR 自己的代码测" >&2; echo "$head"; exit 0; }

stale=""
for ((i = 1; i <= tries; i++)); do
  if git fetch -q --no-tags --depth=2 origin "+refs/pull/$pr/merge:$ref" 2>/dev/null; then
    p1=$(git rev-parse -q --verify "$ref^1" || true)
    p2=$(git rev-parse -q --verify "$ref^2" || true)
    if [[ "$p2" == "$head" ]]; then
      if [[ "$p1" == "$want" ]]; then
        echo "测 GitHub 合出来的 $(git rev-parse "$ref")（$base ${want:0:12} + PR #$pr ${head:0:12}）" >&2
        git rev-parse "$ref"
        exit 0
      fi
      stale=$(git rev-parse "$ref")
    fi
  fi
  if ((i < tries)); then
    gh api "repos/$GITHUB_REPOSITORY/pulls/$pr" --jq .mergeable >/dev/null 2>&1 || true
    sleep "$wait"
  fi
done

if [[ -n "$stale" ]]; then
  echo "::warning::GitHub 的合并提交还是按旧的 $base（$(git rev-parse "$stale^1" | cut -c1-12)，现在是 ${want:0:12}）合的，先测它" >&2
  echo "$stale"
else
  echo "::warning::GitHub 没合出 PR #$pr 和 $base 的合并提交（多半是有冲突），按 PR 自己的代码测" >&2
  echo "$head"
fi
