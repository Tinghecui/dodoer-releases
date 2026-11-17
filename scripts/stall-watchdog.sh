#!/bin/bash
# 跑一条命令；它连续 N 分钟一整行输出都没有，就当它卡死了：整组进程停掉，退出码 124。
# 用法：scripts/stall-watchdog.sh <分钟 | 秒数s> -- <命令…>      （例：20 -- scripts/cowork-desktop-build.sh full；测试用 3s）
#
# 为什么（.cowork/journal/2026-11-17-hackintosh-stall-watchdog.md）：2026-11-17 黑苹果上 next build（Turbopack）打出
# 「Creating an optimized production build ...」以后空等了 110 分钟（CPU 1%），一直到 job 超时被取消，这一班桌面包只好改到 GitHub 的 Mac 上重编。
# 正常编译最长一段没输出是 8 分钟左右（Rust 最后编主程序、链接）。
#
# - 命令的 stdout、stderr 合在一起原样转出来；只认整行（不带换行的进度条不算有输出）。
# - 命令放在自己的进程组里，卡死时连它起的 node、cargo、rustc 一起停（先 TERM，30 秒后 KILL）。
#   本脚本自己收到 TERM / INT / HUP（job 被取消）时也转给那一组。
# - 只用 macOS 自带的东西（bash 3.2、mkfifo、BSD 的 stat；Linux 上用 GNU 的 stat）：黑苹果上没有 timeout、setsid。
set -uo pipefail

lim=${1:-}; shift || true
[[ "${1:-}" == -- ]] && shift
secs=0
if [[ "$lim" =~ ^[0-9]+s$ ]]; then secs=${lim%s}; elif [[ "$lim" =~ ^[0-9]+$ ]]; then secs=$(( lim * 60 )); fi
(( secs > 0 )) || { echo "stall-watchdog.sh：第一个参数要是分钟数（或带 s 的秒数），现在是「${lim}」" >&2; exit 2; }
(( $# )) || { echo "stall-watchdog.sh：没给命令" >&2; exit 2; }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/stall-watchdog.XXXXXX") || exit 2
mkfifo "$tmp/out" || exit 2
touch "$tmp/stamp"
# GNU 的 stat -f 是看文件系统、不报错，所以先试 GNU 的写法；macOS 上它报错，再用 BSD 的
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }

# 读的一端：每读到一整行转出去；同一秒里只碰一次 stamp
(
  last=-1
  while IFS= read -r line || [[ -n "$line" ]]; do
    printf '%s\n' "$line"
    if (( SECONDS != last )); then touch "$tmp/stamp"; last=$SECONDS; fi
  done < "$tmp/out"
) &
reader=$!

# 命令进自己的进程组（set -m 时后台任务的进程组号就是它的 pid）
set -m
"$@" > "$tmp/out" 2>&1 &
pid=$!
set +m

# 还活着：已经退出、等着回收的（ps 里 Z 开头）不算。kill -0 分不出来：命令退出以后没 wait 之前，它对僵尸进程也成功
alive() {
  local st
  st=$(ps -o stat= -p "$1" 2>/dev/null) || return 1
  [[ -n "$st" && "$st" != Z* ]]
}
# 那一组里还有活着的进程
group_alive() { ps -A -o pgid=,stat= 2>/dev/null | awk -v g="$1" '$1 == g && $2 !~ /^Z/ { f = 1 } END { exit !f }'; }
stop_group() {
  kill -TERM -- "-$pid" 2>/dev/null
  local i
  for i in 1 2 3 4 5 6; do
    group_alive "$pid" || break
    sleep 5
  done
  kill -KILL -- "-$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
}
finish() {
  # 命令起的后台进程可能还拿着管道不放：读的那端最多再等 30 秒
  local i
  for i in $(seq 1 30); do
    alive "$reader" || break
    sleep 1
  done
  kill "$reader" 2>/dev/null
  wait "$reader" 2>/dev/null
  rm -rf "$tmp"
  exit "$1"
}
trap 'echo "stall-watchdog.sh：收到停止信号，停掉命令那一组进程"; stop_group; finish 143' TERM INT HUP

while alive "$pid"; do
  # 放到后台再 wait：这样收到信号时 trap 马上跑，不用等 sleep 结束
  sleep 10 &
  wait $! 2>/dev/null
  # 这 10 秒里退出了的，不算卡住
  alive "$pid" || break
  idle=$(( $(date +%s) - $(mtime "$tmp/stamp") ))
  if (( idle >= secs )); then
    echo "::warning::已经 $(( idle / 60 )) 分 $(( idle % 60 )) 秒没有一行输出，当它卡死了：停掉整组进程（scripts/stall-watchdog.sh）"
    stop_group
    finish 124
  fi
done
wait "$pid"
finish $?
