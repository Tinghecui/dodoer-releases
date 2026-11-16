#!/bin/bash
# 在黑苹果上采一份资源数据，打印一行 JSON（状态页用，见 scripts/hackintosh-status-host.sh）。macOS 自带的 bash 3.2 和
# /usr/bin/jq，都是不用 sudo 的命令；采不到的项记 null。
set -uo pipefail
num() { case "$1" in ''|*[!0-9.]*) echo null ;; *) echo "$1" ;; esac; }
load=$(sysctl -n vm.loadavg | tr -d '{}')
# 第二次采样才是这一秒的（第一次是开机以来的平均）
idle=$(top -l 2 -n 0 -s 1 | awk '/CPU usage/ {v=$7} END {sub("%", "", v); print v}')
mem_used=$(vm_stat | awk '/page size of/ {ps=$8} /^Pages active/ {a=$3+0} /^Pages wired down/ {w=$4+0}
                /occupied by compressor/ {c=$5+0} END {printf "%d", (a+w+c)*ps}')
mem_free_pct=$(memory_pressure -Q 2>/dev/null | awk -F': ' '/free percentage/ {sub("%", "", $2); print $2}')
read -r disk_total disk_free <<<"$(df -k /System/Volumes/Data | awk 'END {print $2*1024, $4*1024}')"
swap_used=$(sysctl -n vm.swapusage | awk '{v=$6; m=1; if (v ~ /G$/) m=1024; sub(/[MG]$/, "", v); printf "%d", v*m*1048576}')
boot=$(sysctl -n kern.boottime | sed -E 's/^\{ sec = ([0-9]+),.*/\1/')
# 每个在干活的 runner 有一个 Runner.Worker
workers=$(pgrep -f Runner.Worker | wc -l | tr -d ' ')
metrics=$(jq -cn --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg load "$load" \
  --argjson cpus "$(num "$(sysctl -n hw.ncpu)")" --argjson idle "$(num "$idle")" \
  --argjson mem_total "$(num "$(sysctl -n hw.memsize)")" --argjson mem_used "$(num "$mem_used")" \
  --argjson mem_free_pct "$(num "$mem_free_pct")" --argjson swap_used "$(num "$swap_used")" \
  --argjson disk_total "$(num "$disk_total")" --argjson disk_free "$(num "$disk_free")" \
  --argjson boot "$(num "$boot")" --argjson busy "$(num "$workers")" \
  '{t: $t, load: ($load | split(" ") | map(select(. != "") | tonumber)), cpus: $cpus,
    cpu: (if $idle == null then null else ((100 - $idle) * 10 | round / 10) end),
    mem_total: $mem_total, mem_used: $mem_used, mem_free_pct: $mem_free_pct, swap_used: $swap_used,
    disk_total: $disk_total, disk_free: $disk_free, boot: $boot, busy: $busy}') || metrics=""
[[ -n "$metrics" ]] || exit 1
echo "$metrics"
