#!/bin/bash
# 自动发版（公开镜像的 release-train.yml）发布前，等这个提交在公开 main 上的 Test 跑完：过了才发。
# cowork-release.yml、desktop-macos.yml 在发 Release 之前调它（train 输入为真时）。编包和 Test 同时开始，编包要久得多，
# 所以一般轮到这里 Test 早就跑完了，不多等。
#
#   用法：scripts/cowork-wait-test.sh <提交 sha>
#   环境：GH_TOKEN（要 actions: write，重跑用）、GITHUB_REPOSITORY；GITHUB_OUTPUT 有就写 ok=true|false
#
# Test 第一次没过（failure）：只重跑没过的 job，接着等，第二次还没过才算没过。偶发失败不该让这一班白编：
# 2026-11-14 a2bd2b7f 的 Test 挂了一个和改动无关的 host_ssh::sshd 测试，这一班差点不发，手动重跑一次就过了。
# cowork-release、desktop-macos 两个发布 job 都会走到这里；一个已经点了重跑，另一个看到的就是在跑的第二次，接着等。
# 只在这个提交还是公开 main 的最新提交时重跑：后面有推送的话下一班会把这些改动一起发，而重跑的这次进 Test 的 concurrency
# 会把排着队的那次（更新的提交的）顶掉。
#
# Test 没过、被更新的推送顶掉（main 上排队的 Test 只留最新的一个）、找不到、60 分钟还没跑完，都是 ok=false：
# 这一班不发，退出码照样是 0（不算 CI 红），更新的那次推送会排下一班。
set -euo pipefail

sha="${1:?用法：scripts/cowork-wait-test.sh <提交 sha>}"
repo="${GITHUB_REPOSITORY:?要 GITHUB_REPOSITORY}"

result() { # <true|false> <说明>
  echo "$2" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "ok=$1" >> "$GITHUB_OUTPUT"; fi
  exit 0
}

start=$SECONDS
retried=
while :; do
  run=$(gh api "repos/$repo/actions/workflows/test.yml/runs?head_sha=$sha&branch=main&event=push&per_page=1" \
    --jq '.workflow_runs[0] | select(.) | "\(.status) \(.conclusion // "-") \(.run_attempt) \(.id) \(.html_url)"' || true)
  read -r status conclusion attempt id url <<< "${run:-none - 0 - -}"
  waited=$(( (SECONDS - start) / 60 ))
  if [[ "$status" == completed ]]; then
    case "$conclusion" in
      success) result true "这个提交的 Test 过了：$url" ;;
      cancelled) result false "这个提交的 Test 被更新的推送顶掉了（$url），这一班不发，交给下一班" ;;
      failure) head=$(gh api "repos/$repo/commits/main" --jq .sha || true)
               if [[ "$attempt" == 1 && -z "$retried" && "$head" == "$sha" ]]; then
                 retried=1
                 echo "::warning::这个提交的 Test 没过（$url），重跑一次没过的 job"
                 # 另一个发布 job 已经点了重跑的话这里会失败，不管它：下一轮看到的是在跑的第二次
                 gh api -X POST "repos/$repo/actions/runs/$id/rerun-failed-jobs" > /dev/null || true
                 sleep 30
                 continue
               fi
               if [[ "$attempt" != 1 ]]; then why="重跑过一次"
               elif [[ "$head" != "$sha" ]]; then why="后面已经有推送，不重跑，交给下一班"
               else why="重跑没点上"; fi
               echo "::warning::这个提交的 Test 没过（$why）：$url"
               result false "这个提交的 Test 没过（$why：$url），这一班不发" ;;
      *) echo "::warning::这个提交的 Test 没过（$conclusion）：$url"
         result false "这个提交的 Test 没过（$conclusion：$url），这一班不发" ;;
    esac
  fi
  if [[ "$status" == none && $waited -ge 10 ]]; then result false "等了 10 分钟，公开 main 上没有 ${sha:0:12} 的 Test，这一班不发"; fi
  if [[ $waited -ge 60 ]]; then result false "等了 60 分钟，${sha:0:12} 的 Test 还是 $status（$url），这一班不发"; fi
  echo "Test：$status（已等 $waited 分钟）"
  sleep 30
done
