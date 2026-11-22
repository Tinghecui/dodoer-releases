#!/bin/bash
# cowork-bundle.yml 发版用（不跑 cowork 的代码，只跑这里的脚本）：在私有仓库 Tinghecui/cowork 上建草稿 Release、转正、删草稿。
# 发出来的和 cowork 自己的 release.yml 的 publish 一样：tag v<版本>（转正时由 GitHub 打在 SHA 上）、标题「Cowork <版本>」、
# 说明是 CHANGELOG.md 里这一节加一句升级说明，附件 cowork-<版本>.tar.gz、.sha256、bootstrap.sh。
# 草稿对 /releases/latest、/releases/tags/<tag> 都不可见（cowork upgrade、bootstrap.sh 走这两个），转正前客户看不到。
# 公开日志里只有 COWORK-BEGIN / COWORK-END，细节进 $W/out/release-<命令>.log（report.sh 传到 ci-logs）。
#
# 用法：release.sh draft              建草稿（PUBLISH=yes：tag v<版本>；PUBLISH=draft：预演，tag ci-dryrun-<run id>，不转正，要手动删）
#                                       往 GITHUB_OUTPUT 写 id=<草稿的 id>；那个版本已经发过了就写 id= 并跳过
#       release.sh publish <id>       转正
#       release.sh discard <id>       删掉没转正的草稿
# 环境：W、SHA、VERSION、PUBLISH、GH_TOKEN（cowork 的 contents: write）
set -uo pipefail

CMD=${1:-}
ID=${2:-}
case "$CMD" in draft | publish | discard) ;; *) echo "用法：release.sh draft | publish <id> | discard <id>"; exit 2 ;; esac
: "${W:?}" "${SHA:?}" "${VERSION:?}"
mkdir -p "$W/out" "$W/st"
rm -f "$W/st/rc-release-$CMD"

exec 3>&1
exec > "$W/out/release-$CMD.log" 2>&1
pub() { echo "$*" >&3; }
pub "COWORK-BEGIN"

REPO=Tinghecui/cowork
TAG="v$VERSION"
[[ "${PUBLISH:-}" == draft ]] && TAG="ci-dryrun-${GITHUB_RUN_ID:-0}"

published() { gh api "repos/$REPO/releases/tags/$1" -q .id 2> /dev/null; }   # 只返回已发布的（草稿没有 tag）
drafts() { gh api --paginate "repos/$REPO/releases?per_page=100" -q ".[] | select(.draft and .tag_name == \"$1\") | .id"; }

draft() {
  local id old notes
  if [[ "${PUBLISH:-}" == yes && -n "$(published "$TAG")" ]]; then
    echo "$TAG 已经发过了（同一个版本连着合了两次？），这次只测不发"
    echo "id=" >> "$GITHUB_OUTPUT"
    return 0
  fi
  # 上次没转正留下的草稿（重跑、半路断了）先删
  for old in $(drafts "$TAG"); do echo "删掉旧草稿 $old"; gh api -X DELETE "repos/$REPO/releases/$old" || return 1; done
  local files=("$W/dist/cowork-$VERSION.tar.gz" "$W/dist/cowork-$VERSION.tar.gz.sha256" "$W/dist/bootstrap.sh")
  ls -l "${files[@]}" || return 1
  [[ "$(find "$W/dist" -maxdepth 1 -type f | wc -l)" == 3 ]] || { echo "dist 里不是正好三个文件"; ls -la "$W/dist"; return 1; }
  notes="$(cat "$W/st/notes.md" 2> /dev/null)"
  notes="${notes:-Cowork $VERSION。}

安装见 docs/install.md，升级：\`cowork upgrade $VERSION\`（或门户「版本」页）。"
  local title="Cowork $VERSION"
  [[ "$PUBLISH" == draft ]] && title="预演 Cowork $VERSION（cowork-bundle 的发版预演，会删）"
  gh release create "$TAG" "${files[@]}" -R "$REPO" --draft --target "$SHA" --title "$title" --notes "$notes" || return 1
  id=$(drafts "$TAG" | head -1)
  [[ -n "$id" ]] || { echo "草稿建了但找不到"; return 1; }
  gh api "repos/$REPO/releases/$id" -q '{draft, tag_name, target_commitish, assets: [.assets[] | {name, size}]}'
  echo "id=$id" >> "$GITHUB_OUTPUT"
}

publish() {
  [[ "$ID" =~ ^[0-9]+$ ]] || { echo "要草稿的 id"; return 1; }
  local j
  j=$(gh api "repos/$REPO/releases/$ID") || return 1
  [[ "$(jq -r .draft <<< "$j")" == true && "$(jq -r .tag_name <<< "$j")" == "$TAG" ]] || { echo "$ID 不是 $TAG 的草稿"; return 1; }
  [[ "$(jq '[.assets[].name] | sort == (["bootstrap.sh", "cowork-'"$VERSION"'.tar.gz", "cowork-'"$VERSION"'.tar.gz.sha256"] | sort)' <<< "$j")" == true ]] \
    || { echo "草稿的附件不对"; jq '[.assets[].name]' <<< "$j"; return 1; }
  if [[ -n "$(published "$TAG")" ]]; then
    echo "$TAG 已经有发布的 Release 了，删掉这个草稿"
    gh api -X DELETE "repos/$REPO/releases/$ID"
    return 0
  fi
  # 转正：GitHub 这时才把 tag 打在 target_commitish（SHA）上；make_latest 同私有 publish（gh release create 的默认）
  gh api -X PATCH "repos/$REPO/releases/$ID" -F draft=false -f make_latest=true -q '{tag_name, draft, html_url}' || return 1
  local t
  t=$(gh api "repos/$REPO/git/ref/tags/$TAG" -q .object.sha) || return 1
  echo "tag $TAG → $t"
}

discard() {
  [[ "$ID" =~ ^[0-9]+$ ]] || { echo "要草稿的 id"; return 1; }
  if [[ "$(gh api "repos/$REPO/releases/$ID" -q .draft 2> /dev/null)" == true ]]; then
    gh api -X DELETE "repos/$REPO/releases/$ID" || return 1
    echo "删掉了草稿 $ID"
  else
    echo "$ID 不是草稿了（或已经没了），不动"
  fi
}

rc=0
"$CMD" || rc=$?
echo "$rc" > "$W/st/rc-release-$CMD"
pub "COWORK-END rc=$rc"
exit "$rc"
