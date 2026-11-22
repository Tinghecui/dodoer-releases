#!/bin/bash
# 跑桌面 e2e 的几段 spec（公开镜像 desktop-e2e.yml 调）：每段开一次 app（wdio run），中间 app 退出、数据目录不变，就是「退出重开」。
# 开窗口之前先跑第 0 段：`codeg --local-daemon-smoke`（自带的 daemon 子进程起、鉴权、被杀后自动重启、停）；
# 再起一个独立的 codeg-server 当「远端服务器」（E2E_REMOTE_URL / _TOKEN / _PID 传给 spec），几段共用，最后停掉。
# 每段跑完查 app 的进程清干净了没有（codeg、它带起来的 codeg-server；当远端的那个不算），记成那一段的最后一步。
# WebdriverIO 的输出全进 $E2E_OUT/wdio-phase<N>.log（跟截图、app 日志一起传到私有 Release，见 desktop-e2e-artifacts.yml），
# 公开日志和 $GITHUB_STEP_SUMMARY 只有摘要表：每一步的名字、过没过、几秒。
#
#   用法：scripts/desktop-e2e/run.sh            在仓库根目录跑；Linux 上自己套 xvfb-run + dbus-run-session
#   环境：E2E_APP、E2E_OUT（默认 e2e-out）、E2E_PHASES（默认 "1 2 3"）；E2E_DATA_DIR 不给就建一个临时目录（几段共用）
# macOS 自带 bash 3.2：变量后面紧跟全角字符要写 ${x}，不然 set -u 下会被当成变量名的一部分。
# 来历：源仓库 .cowork/journal/2026-11-21-desktop-e2e-skeleton.md
set -uo pipefail

# 收尾那步会 kill -9 叫 codeg / codeg-server 的进程：只在一次性的 CI 机器上跑，别在装着 codeg 的机器上跑
[[ "${CI:-}" == true ]] || { echo "只在 CI 机器上跑（CI=true）：收尾会杀掉本机的 codeg / codeg-server 进程" >&2; exit 2; }

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
export E2E_OUT="${E2E_OUT:-$root/e2e-out}"
mkdir -p "$E2E_OUT"
export E2E_DATA_DIR="${E2E_DATA_DIR:-$(mktemp -d)}"
phases="${E2E_PHASES:-1 2 3}"
app="${E2E_APP:-$root/src-tauri/target/debug/codeg}"
server="$(dirname "$app")/codeg-server"
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
  return "$rc"
}

# 一步结果写进 result-phase<N>.json 的 steps（第 0 段、每段收尾的进程检查用；spec 自己写的那份在它后面追加）
add_step() {
  node -e '
    const fs = require("node:fs")
    const [f, name, ok, seconds, detail] = process.argv.slice(1)
    let r = { phase: f.match(/phase(\d+)/)[1], steps: [] }
    try { r = JSON.parse(fs.readFileSync(f, "utf8")) } catch {}
    r.steps.push({ name, ok: ok === "1", seconds: Number(seconds), detail })
    fs.writeFileSync(f, JSON.stringify(r, null, 2))
  ' "$E2E_OUT/result-phase$1.json" "$2" "$3" "$4" "${5:-}"
}

rc=0
t0=$(date +%s)
if out=$(CODEG_DATA_DIR="$E2E_DATA_DIR" CODEG_HOME="$E2E_DATA_DIR" "$app" --local-daemon-smoke 2>&1); then
  add_step 0 "自带的 daemon 子进程：起、鉴权、被杀后自动重启、停（--local-daemon-smoke）" 1 "$(( $(date +%s) - t0 ))"
else
  add_step 0 "自带的 daemon 子进程：起、鉴权、被杀后自动重启、停（--local-daemon-smoke）" 0 "$(( $(date +%s) - t0 ))" "$(printf '%s' "$out" | tail -c 400)"
  rc=1
fi
printf '%s\n' "$out" > "$E2E_OUT/local-daemon-smoke.log"

# 远端服务器
remote_dir=$(mktemp -d)
export E2E_REMOTE_TOKEN="e2e-remote-$(date +%s)-$RANDOM"
CODEG_DATA_DIR="$remote_dir" CODEG_HOME="$remote_dir" CODEG_HOST=127.0.0.1 CODEG_PORT=3981 CODEG_TOKEN="$E2E_REMOTE_TOKEN" \
  CODEG_BRIDGE_PORTS=off CODEG_UPDATE_DISABLED=1 CODEG_TELEMETRY_ENV=ci "$server" > "$E2E_OUT/remote-server.log" 2>&1 &
remote_pid=$!
for _ in $(seq 1 90); do
  if curl -fsS -m 2 -X POST -H "authorization: Bearer $E2E_REMOTE_TOKEN" -H 'content-type: application/json' -d '{}' \
    http://127.0.0.1:3981/api/health > /dev/null 2>&1; then
    export E2E_REMOTE_URL=http://127.0.0.1:3981 E2E_REMOTE_PID=$remote_pid
    break
  fi
  sleep 1
done
[[ -n "${E2E_REMOTE_URL:-}" ]] || echo "远端 codeg-server 90 秒内没起来（远程那几项会报没过）"

# 开始之前就在的 codeg / codeg-server（不是这次起的）不算、也不杀
before=$( (pgrep -x codeg; pgrep -x codeg-server) 2>/dev/null | tr '\n' ' ' || true)

# 这一段的 app 退干净了没有：codeg 和它带起来的 codeg-server（当远端的那个、开始之前就在的除外）
check_clean() {
  local n="$1" t0 left="" i
  t0=$(date +%s)
  for i in $(seq 1 15); do
    left=""
    for p in $( (pgrep -x codeg; pgrep -x codeg-server) 2>/dev/null || true); do
      [[ "$p" == "$remote_pid" || " $before " == *" $p "* ]] || left="$left $p"
    done
    [[ -z "${left// /}" ]] && break
    sleep 1
  done
  if [[ -z "${left// /}" ]]; then
    add_step "$n" "这一段的 app 退出后进程清干净（codeg、自带的 codeg-server）" 1 "$(( $(date +%s) - t0 ))"
  else
    add_step "$n" "这一段的 app 退出后进程清干净（codeg、自带的 codeg-server）" 0 "$(( $(date +%s) - t0 ))" "还在：pid ${left}"
    kill -9 $left 2>/dev/null || true
    rc=1
  fi
}

for n in $phases; do
  run_phase "$n" || rc=1
  check_clean "$n"
done
kill "$remote_pid" 2>/dev/null || true

# 摘要：每段的每一步（名字、过没过、秒数）；没写出结果文件的段（app 没起来、spec 没跑到）单独报
node - "$E2E_OUT" "$phases" "$os" <<'EOF' | tee -a "$summary"
const { readFileSync, existsSync } = require("node:fs")
const [out, phases, os] = process.argv.slice(2)
const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 160)
const rows = []
let failed = 0
for (const p of ["0", ...phases.split(/\s+/).filter(Boolean)]) {
  const f = `${out}/result-phase${p}.json`
  if (!existsSync(f)) {
    failed++
    rows.push(`| ${p} | （没有结果：app 没起来或 spec 没跑到，看 wdio-phase${p}.log） | **没过** | |`)
    continue
  }
  const r = JSON.parse(readFileSync(f, "utf8"))
  // spec 自己的 writeResult 带 platform；只有 run.sh 收尾那一步的，是 spec 没跑到
  if (p !== "0" && !r.platform) {
    failed++
    rows.push(`| ${p} | （spec 没写出结果：app 没起来或 spec 没跑到，看 wdio-phase${p}.log） | **没过** | |`)
  }
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
