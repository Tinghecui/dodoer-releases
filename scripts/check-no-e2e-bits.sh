#!/bin/bash
# 发版安全：正式的桌面包 / 前端里不能有 e2e 测试版才有的东西（WebdriverIO 的两个插件）。
# - Rust：cargo feature `e2e`（src-tauri/src/e2e.rs）注册 tauri-plugin-wdio-webdriver（127.0.0.1 上不用鉴权的 WebDriver 端口）
#   和 tauri-plugin-wdio（在页面里执行任意脚本）。release 编译开它会 compile_error，这里再从产物上核对一遍
# - 前端：@wdio/tauri-plugin（src/lib/e2e/vendor/）只在 NEXT_PUBLIC_CODEG_E2E=1 编的前端里，正常编的前端连 chunk 都不该有
#
#   用法：scripts/check-no-e2e-bits.sh <文件或目录>...   （比如 dodoer.app、out/、target/release/codeg）
#   找到就列出命中的文件、返回 1；都没有返回 0。目录递归找，二进制按字节找（grep -a）。
#   desktop-e2e-spike.yml 拿 e2e 测试版反过来跑一遍，确认它真的找得到（不然这条检查永远是绿的）。
# 来历：.cowork/journal/2026-11-21-e2e-wdio-plugin.md
set -euo pipefail

(($# > 0)) || { echo "用法：$0 <文件或目录>..." >&2; exit 2; }

# 两个插件特有的字符串：Rust 的 crate 名 / 插件名 / 日志，前端 bundle 的全局变量和命令名
pattern='tauri[-_]plugin[-_]wdio|plugin:wdio\||wdio-webdriver|WDIO WebDriver plugin|WDIO Tauri Plugin|wdioTauri|__wdio_mocks__'

hits=0
for target in "$@"; do
  [[ -e "$target" ]] || { echo "::error::没有 $target" >&2; exit 2; }
  while IFS= read -r f; do
    echo "::error::$f 里有 e2e 测试版的东西（$(grep -aoE "$pattern" "$f" | sort | uniq -c | tr -s ' ' | head -5 | tr '\n' ';')）"
    hits=$((hits + 1))
  done < <(grep -rlaE "$pattern" "$target" || true)
done
if ((hits > 0)); then
  echo "::error::${hits} 个文件带着 WebdriverIO 插件：正式包不能用 \`--features e2e\` 编，前端不能带 NEXT_PUBLIC_CODEG_E2E=1" >&2
  exit 1
fi
echo "没有 e2e 测试版的东西：$*"
