#!/bin/bash
# 给黑苹果状态页记一份负载、内存、磁盘：ssh 到黑苹果跑 scripts/hackintosh-status-collect.sh，再用
# scripts/hackintosh-status-record.sh 记到公开仓库 hackintosh-status 分支的 host/。
# 不放在心跳 job 里采：3 个 runner 都忙时心跳排着，最该看负载的时候反而没数（2026-11-16 上线第一个小时就是这样）。
# 跑在派心跳的那台机器上（crontab 每 10 分钟，和派心跳同一条思路），装法：把这三个脚本拷到同一个目录，crontab 里调这个。
#
#   环境：HACKINTOSH_SSH（ssh 的主机名，默认 hackintosh，要能免密码登录）、STATUS_REPO（默认 Tinghecui/dodoer-releases）、
#        GH_TOKEN（不给就用 gh auth token，要能写那个仓库）
# 连不上就不记（页面上这一格就是「没联系上」），退出码 1
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
line=$(ssh -o BatchMode=yes -o ConnectTimeout=15 "${HACKINTOSH_SSH:-hackintosh}" 'bash -s' < "$here/hackintosh-status-collect.sh") || {
  echo "$(date -u +%FT%TZ) 连不上黑苹果，这次不记" >&2; exit 1; }
GH_TOKEN="${GH_TOKEN:-$(gh auth token)}" GITHUB_REPOSITORY="${STATUS_REPO:-Tinghecui/dodoer-releases}" \
  bash "$here/hackintosh-status-record.sh" host "$line"
