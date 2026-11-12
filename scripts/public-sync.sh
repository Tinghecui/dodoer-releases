#!/bin/bash
# 把本仓库的一个提交同步成公开仓库 Tinghecui/dodoer-releases 的一个干净提交（规则见 COWORK.md「公开镜像」）：
# 导出该提交的文件 → 删掉 .github/public/exclude.txt 列的 → .github/public/workflows 挪到 .github/workflows →
# 按 denylist.txt / allowlist.txt 扫一遍，命中就不推 → 在公开仓库里做一个提交（作者固定、信息只带主题行）推上去。
# 公开仓库的历史和本仓库无关：main 是一条线，每个提交对应本仓库 product 分支的一次推送；PR 分支 pr/<n> 是 main 上的一个提交。
#
#   用法：scripts/public-sync.sh export <ref> <目录>                  只导出、扫描，不碰公开仓库（本地自查用）
#        scripts/public-sync.sh push <ref> main                       推到公开仓库的 main（树没变就不推）
#        scripts/public-sync.sh push <ref> pr/<n>                     以公开 main 为父做一个提交，强推到 pr/<n>
#        scripts/public-sync.sh push <ref> macos/pr/<n>               同上，推到 macos/pr/<n>（PR 打了 macos-build 标签，那边的 desktop-macos 编它）
#        scripts/public-sync.sh push <ref> qa/<run>                   同上，推到 qa/<run>（AI QA 要测没发版的代码，那边的 qa-package 编包；.cowork/ai-qa/build-package.sh）
#        scripts/public-sync.sh tag <tag>                             同步 tag（树和公开 main 一样就打在 main 上）
#        scripts/public-sync.sh delete pr/<n>|macos/pr/<n>            删公开仓库的分支
#   环境：PUBLIC_REPO（默认 git@github.com:Tinghecui/dodoer-releases.git）、PUBLIC_DIR（公开仓库的 clone 放哪，默认临时目录）；
#        push / tag / delete 要能 ssh 推公开仓库（GIT_SSH_COMMAND 指定 deploy key，见 .github/workflows/public-sync.yml）。
#        GITHUB_OUTPUT 有就写 commit=<公开仓库的提交>。
set -euo pipefail

cmd="${1:?用法见文件头}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
cfg="$root/.github/public"
PUBLIC_REPO="${PUBLIC_REPO:-git@github.com:Tinghecui/dodoer-releases.git}"
AUTHOR_NAME=Tinghecui
AUTHOR_EMAIL=54262737+Tinghecui@users.noreply.github.com

fail() { echo "::error::$*" >&2; exit 1; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# 扫描：第一个参数是目录或文件，其余是额外要扫的文本（提交信息）。命中返回 1
scan() {
  local target="$1"; shift
  local deny="$tmp/deny.re" allow="$tmp/allow.re" hits="$tmp/hits"
  grep -v '^[[:space:]]*#' "$cfg/denylist.txt" | grep -v '^[[:space:]]*$' > "$deny"
  grep -v '^[[:space:]]*#' "$cfg/allowlist.txt" | grep -v '^[[:space:]]*$' > "$allow"
  : > "$hits"
  # -I 跳过二进制；allowlist 为空时 grep -f 空文件会什么都不匹配，所以单独处理
  if [[ -d "$target" ]]; then grep -rEIin -f "$deny" "$target" >> "$hits" || true
  else grep -EIin -f "$deny" "$target" >> "$hits" || true; fi
  for text in "$@"; do printf '%s\n' "$text" | grep -EIin -f "$deny" | sed 's/^/（提交信息）:/' >> "$hits" || true; done
  if [[ -s "$allow" ]]; then grep -vEi -f "$allow" "$hits" > "$hits.final" || true; else cp "$hits" "$hits.final"; fi
  if [[ -s "$hits.final" ]]; then
    echo "::error::导出的内容命中 .github/public/denylist.txt，不同步。命中的行："
    sed "s#^$target/##" "$hits.final" | cut -c1-300 | head -50
    return 1
  fi
}

# 导出 <ref> 到 <目录>：去掉 exclude.txt 列的，workflows 挪位，再扫描
export_tree() {
  local ref="$1" out="$2"
  mkdir -p "$out"
  git archive "$ref" | tar -x -C "$out"
  while IFS= read -r line; do
    line="${line%%#*}"; line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" ]] && continue
    # shellcheck disable=SC2086
    (cd "$out" && rm -rf -- $line)
  done < "$cfg/exclude.txt"
  if [[ -d "$out/.github/public/workflows" ]]; then
    mkdir -p "$out/.github"
    rm -rf "$out/.github/workflows"
    mv "$out/.github/public/workflows" "$out/.github/workflows"
  fi
  rm -rf "$out/.github/public"
  [[ -f "$out/package.json" && -d "$out/src-tauri" ]] || fail "导出的目录不像 codeg 的代码：$out"
}

# 公开仓库的 clone（只要 main 的最新一个提交；tag 的那次会按需拉）
public_clone() {
  if [[ -z "${PUBLIC_DIR:-}" ]]; then PUBLIC_DIR="$tmp/public"; fi
  if [[ ! -d "$PUBLIC_DIR/.git" ]]; then
    git clone -q --depth=1 --branch main "$PUBLIC_REPO" "$PUBLIC_DIR"
  else
    git -C "$PUBLIC_DIR" fetch -q --depth=1 origin main
    git -C "$PUBLIC_DIR" checkout -q -B main origin/main
  fi
  git -C "$PUBLIC_DIR" config user.name "$AUTHOR_NAME"
  git -C "$PUBLIC_DIR" config user.email "$AUTHOR_EMAIL"
}

# 把导出的目录写成公开仓库里的一棵树（不动工作区的文件，只用临时索引），输出树的 id
write_tree() {
  local src="$1"
  (cd "$PUBLIC_DIR" && GIT_INDEX_FILE="$tmp/index" git read-tree --empty \
    && GIT_INDEX_FILE="$tmp/index" GIT_WORK_TREE="$src" git add -A -f . \
    && GIT_INDEX_FILE="$tmp/index" git write-tree)
}

commit_tree() { # <tree> <parent> <message>
  (cd "$PUBLIC_DIR" && GIT_AUTHOR_NAME=$AUTHOR_NAME GIT_AUTHOR_EMAIL=$AUTHOR_EMAIL GIT_COMMITTER_NAME=$AUTHOR_NAME GIT_COMMITTER_EMAIL=$AUTHOR_EMAIL \
    git commit-tree "$1" -p "$2" -m "$3")
}

case "$cmd" in
  export)
    ref="${2:?ref}"; out="${3:?目录}"
    export_tree "$ref" "$out"
    scan "$out" "$(git log -1 --format=%s "$ref")"
    echo "导出到 ${out}，扫描通过"
    ;;
  push)
    ref="${2:?ref}"; branch="${3:?main、pr/<n>、macos/pr/<n> 或 qa/<run>}"
    sha=$(git rev-parse "$ref")
    subject=$(git log -1 --format=%s "$sha")
    export_tree "$sha" "$tmp/export"
    scan "$tmp/export" "$subject"
    # qa/<run> 推上去就是为了让公开仓库编包，标题里的 [skip ci] 之类要拿掉，不然 GitHub 不触发 qa-package：
    # AI QA 提交测试记忆的标题带 [skip ci]，紧接着再跑一轮时它正好是分支最新的提交（2026-11-12 run 43252995910，等了十分钟没有 run）
    if [[ "$branch" == qa/* ]]; then
      subject=$(printf '%s\n' "$subject" | sed -E 's/ *\[(skip ci|ci skip|no ci|skip actions|actions skip)\]//Ig')
      subject="${subject:-qa}"
    fi
    public_clone
    base=$(git -C "$PUBLIC_DIR" rev-parse origin/main)
    tree=$(write_tree "$tmp/export")
    msg="$subject

source: cowork-codeg@${sha}"
    if [[ "$branch" == main ]]; then
      if [[ "$tree" == "$(git -C "$PUBLIC_DIR" rev-parse "$base^{tree}")" ]]; then
        echo "公开 main 已经是这棵树（${base}），不用推"; commit=$base
      else
        commit=$(commit_tree "$tree" "$base" "$msg")
        git -C "$PUBLIC_DIR" push -q origin "$commit:refs/heads/main"
        echo "推到公开 main：$commit"
      fi
    elif [[ "$branch" == pr/* || "$branch" == macos/pr/* || "$branch" == qa/* ]]; then
      # 总是做一个新提交（树和 main 一样也做，CI 要有东西跑），父是公开 main，强推
      commit=$(commit_tree "$tree" "$base" "$msg")
      git -C "$PUBLIC_DIR" push -q -f origin "$commit:refs/heads/$branch"
      echo "推到公开 ${branch}：${commit}（父 ${base}）"
    else
      fail "分支只能是 main、pr/<n>、macos/pr/<n> 或 qa/<run>：$branch"
    fi
    # 写成 if，别写 `[[ ]] && echo`：GITHUB_OUTPUT 为空时（workflow 推 macos/pr/<n> 那次）它是最后一条命令，返回 1，整个脚本就算失败
    if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "commit=$commit" >> "$GITHUB_OUTPUT"; fi
    ;;
  tag)
    tag="${2:?tag}"
    git rev-parse -q --verify "refs/tags/$tag" >/dev/null || fail "本仓库没有 tag $tag"
    sha=$(git rev-parse "$tag^{commit}")
    subject=$(git log -1 --format=%s "$sha")
    tagmsg=$(git tag -l --format='%(contents:subject)' "$tag"); tagmsg="${tagmsg:-$tag}"
    export_tree "$sha" "$tmp/export"
    scan "$tmp/export" "$subject" "$tagmsg"
    public_clone
    if git -C "$PUBLIC_DIR" ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null; then
      echo "公开仓库已经有 tag ${tag}，不动"; exit 0
    fi
    base=$(git -C "$PUBLIC_DIR" rev-parse origin/main)
    tree=$(write_tree "$tmp/export")
    if [[ "$tree" == "$(git -C "$PUBLIC_DIR" rev-parse "$base^{tree}")" ]]; then
      commit=$base
    else
      # tag 指的不是 product 分支最新的那次推送：单独做一个提交挂在 main 下面打 tag，不动 main
      commit=$(commit_tree "$tree" "$base" "$subject

source: cowork-codeg@${sha}")
    fi
    (cd "$PUBLIC_DIR" && GIT_COMMITTER_NAME=$AUTHOR_NAME GIT_COMMITTER_EMAIL=$AUTHOR_EMAIL git tag -a "$tag" -m "$tagmsg" "$commit" \
      && git push -q origin "refs/tags/$tag")
    echo "公开仓库打了 tag $tag → $commit"
    if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "commit=$commit" >> "$GITHUB_OUTPUT"; fi
    ;;
  delete)
    branch="${2:?pr/<n> 或 macos/pr/<n>}"
    [[ "$branch" == pr/* || "$branch" == macos/pr/* ]] || fail "只删 pr/<n> 和 macos/pr/<n>：$branch"
    public_clone
    if git -C "$PUBLIC_DIR" ls-remote --exit-code --heads origin "$branch" >/dev/null; then
      git -C "$PUBLIC_DIR" push -q origin --delete "$branch" && echo "删了公开仓库的 $branch"
    else
      echo "公开仓库没有 $branch"
    fi
    ;;
  *) fail "不认识的命令 $cmd" ;;
esac
