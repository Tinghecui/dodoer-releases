#!/bin/bash
# 推送前在本机自查，只跑轻量的：生产机上不许跑 cargo、rustfmt、整项目 tsc、pnpm build、全量 vitest（AGENTS.md），
# 这些交给 CI。这里把 CI 上反复挂过、本机又查得了的先查掉（AGENTS.md「CI 上常挂的错误」）。
# 查的是这个分支相对 product/v0.40.0 改了的文件（包括还没提交的）：
#   - 公开同步的 denylist：命中了 PR 同步不过去，CI 也不跑。用 scripts/public-sync.sh export，只查已经提交的 HEAD
#   - 改了 .github/public/workflows：actionlint（和 CI 同一个版本、同样的参数）、scripts/check-workflow-permissions.py
#   - 改了前端：只对改了的文件跑 eslint（prettier 也在里面）；改了的测试文件、和改了的源文件同名的测试文件，
#     用 vitest 一个个跑（--pool=forks --maxWorkers=1）。没装 node_modules 就跳过
#   - 改了 Rust：只看新加的行，grep 两种一定过不了 clippy 的写法
#
# 用法：bash scripts/cowork-precheck.sh [基准分支，默认 product/v0.40.0]；有问题退出码 1
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

base_branch=${1:-product/v0.40.0}
base_ref=$(git for-each-ref --format='%(refname:short)' "refs/remotes/*/$base_branch" | head -1)
base_ref=${base_ref:-$base_branch}
base=$(git merge-base HEAD "$base_ref" 2>/dev/null) || { echo "找不到 $base_branch，先 git fetch"; exit 2; }

# 和基准比改了的（工作区里的，包括没提交的）+ 新建还没 add 的；删掉的不算
mapfile -t files < <({ git diff --name-only "$base"; git ls-files --others --exclude-standard; } | sort -u |
  while IFS= read -r f; do [[ -f "$f" ]] && printf '%s\n' "$f"; done)

fail=0
bad() { echo "✗ $*"; fail=1; }
ok() { echo "✓ $*"; }
skip() { echo "- $*"; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
pick() { printf '%s\n' "${files[@]}" | grep -E "$1" || true; }

echo "和 $base_ref（$(git rev-parse --short "$base")）比，改了 ${#files[@]} 个文件"
[[ ${#files[@]} -gt 0 ]] || exit 0

# denylist
if [[ -n "$(git status --porcelain)" ]]; then skip "还有没提交的改动，denylist 只查了已经提交的 HEAD"; fi
if bash scripts/public-sync.sh export HEAD "$tmp/export" > "$tmp/sync.log" 2>&1; then
  ok "denylist"
else
  bad "denylist（或导出失败）："; sed 's/^/    /' "$tmp/sync.log" | head -30
fi

# workflow
mapfile -t workflows < <(pick '^\.github/public/workflows/.*\.ya?ml$')
if [[ ${#workflows[@]} -gt 0 ]]; then
  # 照公开仓库的布局放一份（含没提交的改动），本地的 uses: ./.github/workflows/x.yml 才找得到
  mkdir -p "$tmp/wf/.github/workflows" && cp .github/public/workflows/*.yml "$tmp/wf/.github/workflows/"
  version=$(sed -n 's#.*rhysd/actionlint/v\([0-9.]*\)/.*#\1#p' .github/public/workflows/test.yml | head -1)
  bin="${XDG_CACHE_HOME:-$HOME/.cache}/cowork-precheck/actionlint-$version"
  if [[ ! -x "$bin" && -n "$version" ]]; then
    mkdir -p "$(dirname "$bin")" && (cd "$tmp" &&
      bash <(curl -sSfL "https://raw.githubusercontent.com/rhysd/actionlint/v$version/scripts/download-actionlint.bash") "$version" >/dev/null 2>&1 &&
      mv actionlint "$bin") || true
  fi
  if [[ -x "$bin" ]]; then
    if (cd "$tmp/wf" && "$bin" -shellcheck= -pyflakes= -ignore 'string should not be empty' .github/workflows/*.yml) > "$tmp/al.log" 2>&1; then
      ok "actionlint"
    else
      bad "actionlint："; sed 's/^/    /' "$tmp/al.log" | head -30
    fi
  else
    skip "actionlint 下载不下来，没查"
  fi
  if [[ -f scripts/check-workflow-permissions.py ]]; then
    if python3 -I scripts/check-workflow-permissions.py "$tmp/wf/.github/workflows" > "$tmp/perm.log" 2>&1; then
      ok "可复用 workflow 的权限"
    else
      bad "可复用 workflow 的权限："; sed 's/^/    /' "$tmp/perm.log"
    fi
  fi
fi

# 前端
mapfile -t fe < <(pick '^(src|browser-agent)/.*\.(ts|tsx|js|jsx|mjs)$')
if [[ ${#fe[@]} -gt 0 ]]; then
  if [[ ! -d node_modules ]]; then
    skip "前端改了 ${#fe[@]} 个文件，没装 node_modules，eslint、vitest 没跑"
  else
    if pnpm exec eslint "${fe[@]}" > "$tmp/eslint.log" 2>&1; then ok "eslint（${#fe[@]} 个文件）"; else bad "eslint："; sed 's/^/    /' "$tmp/eslint.log" | head -40; fi
    tests=()
    for f in "${fe[@]}"; do
      if [[ "$f" =~ \.test\.(ts|tsx)$ ]]; then tests+=("$f"); continue; fi
      for t in "${f%.*}.test.ts" "${f%.*}.test.tsx"; do [[ -f "$t" ]] && tests+=("$t"); done
    done
    mapfile -t tests < <(printf '%s\n' "${tests[@]}" | grep . | sort -u)
    if [[ ${#tests[@]} -gt 0 ]]; then
      if pnpm exec vitest run --pool=forks --maxWorkers=1 "${tests[@]}" > "$tmp/vitest.log" 2>&1; then
        ok "vitest（${#tests[@]} 个测试文件）"
      else
        bad "vitest："; grep -E 'FAIL|✗|×|Error|expected' "$tmp/vitest.log" | sed 's/^/    /' | head -30
      fi
    fi
  fi
fi

# Rust：新加的行里两种一定过不了 clippy 的写法
if [[ -n "$(pick '^src-tauri/.*\.rs$')" ]]; then
  { git diff -U0 "$base" -- 'src-tauri/*.rs'
    git ls-files --others --exclude-standard -- 'src-tauri/*.rs' | while IFS= read -r f; do git diff -U0 --no-index /dev/null "$f"; done
  } | awk '
    /^\+\+\+ / { file = substr($2, 3); next }
    /^@@/ { split($3, a, ","); line = substr(a[1], 2) + 0; next }
    /^\+/ {
      text = substr($0, 2)
      if (text ~ /&\[[A-Za-z_][A-Za-z0-9_.]*\.clone\(\)\]/)
        printf "%s:%d: cloned_ref_to_slice_refs：&[x.clone()] 写成 std::slice::from_ref(&x)\n    %s\n", file, line, text
      if (text ~ /\.(contains|split|splitn|rsplit|find|rfind|matches|starts_with|ends_with|trim_matches|trim_start_matches|trim_end_matches|replace)\(\|[A-Za-z_]+(: *char)?\| *(matches!\(|[A-Za-z_]+ *== *\x27)/)
        printf "%s:%d: manual_pattern_char_comparison：字符比较的闭包写成数组，比如 [\x27#\x27, \x27 \x27]\n    %s\n", file, line, text
      line++
    }' > "$tmp/rust.log"
  if [[ -s "$tmp/rust.log" ]]; then bad "Rust（clippy 会挂）："; sed 's/^/    /' "$tmp/rust.log"; else ok "Rust 常见 clippy 写法"; fi
  skip "Rust 的编译、clippy、测试、格式只有 CI 查（格式只查改了的行，没过时下载产物 rustfmt-patch 再 git apply）"
fi

exit $fail
