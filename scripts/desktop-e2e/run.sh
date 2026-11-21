#!/bin/bash
# 跑桌面 e2e 的几段 spec（公开镜像 desktop-e2e.yml 调）：每段开一次 app（wdio run），中间 app 退出、数据目录不变，就是「退出重开」。
# WebdriverIO 的输出全进 $E2E_OUT/wdio-phase<N>.log（跟截图、app 日志一起传到私有 Release，见 desktop-e2e-artifacts.yml），
# 公开日志和 $GITHUB_STEP_SUMMARY 只有摘要表：每一步的名字、过没过、几秒。
#
#   用法：scripts/desktop-e2e/run.sh            在仓库根目录跑；Linux 上自己套 xvfb-run + dbus-run-session
#   环境：E2E_APP、E2E_OUT（默认 e2e-out）、E2E_PHASES（默认 "1 2 3"）；E2E_DATA_DIR 不给就建一个临时目录（几段共用）
# macOS 自带 bash 3.2：变量后面紧跟全角字符要写 ${x}，不然 set -u 下会被当成变量名的一部分。
# 来历：源仓库 .cowork/journal/2026-11-21-desktop-e2e-skeleton.md
set -uo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
export E2E_OUT="${E2E_OUT:-$root/e2e-out}"
mkdir -p "$E2E_OUT"
export E2E_DATA_DIR="${E2E_DATA_DIR:-$(mktemp -d)}"
phases="${E2E_PHASES:-1 2 3}"
wdio="$root/scripts/desktop-e2e/node_modules/.bin/wdio"
conf="$root/scripts/desktop-e2e/wdio.conf.mjs"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
os="$(uname -s)"

run_phase() {
  local n="$1" t0 rc=0
  t0=$(date +%s)
  if [[ "$os" == Linux ]]; then
    E2E_PHASE="$n" xvfb-run -a --server-args="-screen 0 1440x900x24" dbus-run-session -- \
      "$wdio" run "$conf" > "$E2E_OUT/wdio-phase${n}.log" 2>&1 || rc=$?
  else
    E2E_PHASE="$n" "$wdio" run "$conf" > "$E2E_OUT/wdio-phase${n}.log" 2>&1 || rc=$?
  fi
  echo "第 ${n} 段：rc=${rc}，$(( $(date +%s) - t0 )) 秒"
  # 上一段的 app 没退干净就杀掉，不然下一段会连到它、数据也可能没落盘（记在结果里，第 2、3 段的「只有一个进程」会查）
  sleep 2
  local left
  left=$(pgrep -x codeg || true)
  if [[ -n "$left" ]]; then
    echo "第 ${n} 段跑完还有 codeg 进程，杀掉"
    kill -9 $left 2>/dev/null || true
    sleep 1
  fi
  return "$rc"
}

rc=0
for n in $phases; do
  run_phase "$n" || rc=1
done

# 摘要：每段的每一步（名字、过没过、秒数）；没写出结果文件的段（app 没起来、spec 没跑到）单独报
node - "$E2E_OUT" "$phases" "$os" <<'EOF' | tee -a "$summary"
const { readFileSync, existsSync } = require("node:fs")
const [out, phases, os] = process.argv.slice(2)
const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 160)
const rows = []
let failed = 0
for (const p of phases.split(/\s+/).filter(Boolean)) {
  const f = `${out}/result-phase${p}.json`
  if (!existsSync(f)) {
    failed++
    rows.push(`| ${p} | （没有结果：app 没起来或 spec 没跑到，看 wdio-phase${p}.log） | **没过** | |`)
    continue
  }
  const r = JSON.parse(readFileSync(f, "utf8"))
  for (const s of r.steps) {
    if (!s.ok) failed++
    rows.push(`| ${p} | ${esc(s.name)}${s.ok ? "" : `：${esc(s.detail)}`} | ${s.ok ? "过" : "**没过**"} | ${s.seconds.toFixed(1)} |`)
  }
}
console.log(`### 桌面 e2e（${os}）：${failed ? `${failed} 项没过` : "全过"}\n`)
console.log("| 段 | 步骤 | 结果 | 秒 |\n| --- | --- | --- | --- |")
console.log(rows.join("\n"))
console.log("\n截图、WebdriverIO 日志、app 日志在私有仓库 Release ai-qa-artifacts 的 desktop-e2e-<run>-* 附件里（desktop-e2e-artifacts.yml 搬过去）。\n")
EOF
exit "$rc"
