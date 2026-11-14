#!/bin/bash
# Asks a Mac whether an app could serve SSH to one connection of its own,
# without the system's Remote Login, and what such a session can reach. The
# measurements the "lend this computer's shell to a remote workspace" design
# needs before any of it is built (.cowork/journal/2026-11-14-host-ssh.md).
#
#     bash scripts/host-ssh-probe.sh
#
# It starts the system's own sshd as the person running it, for one connection
# at a time over a pipe (no port is opened), with keys made for this run, and
# asks the same questions twice: straight from this terminal, and through that
# session. Then it removes everything it made. It prints whether things could
# be read, never what was read; the screenshot it takes is deleted unseen, the
# keychain entry it writes is its own and is deleted, and Calculator is opened
# and closed only if it was not already running.
#
# Manual, not part of any test run: it needs a person's own Mac.
set -u

report=""
say() {
  printf '%s: %s\n' "$1" "$2"
  report="${report}$1: $2
"
}

if [ "$(uname)" != "Darwin" ] && [ -z "${PROBE_ANY_OS:-}" ]; then
  echo "这个脚本要在 Mac 上跑"
  exit 1
fi
sshd=/usr/sbin/sshd
if [ ! -x "$sshd" ]; then
  say "系统自带的 sshd" "没有"
  exit 1
fi

dir=$(mktemp -d /tmp/dodoer-probe.XXXXXX) || exit 1
listener=""
cleanup() {
  [ -n "$listener" ] && kill "$listener" 2>/dev/null
  rm -rf "$dir"
}
trap cleanup EXIT

me=$(id -un)
# Stops a question that is waiting on a permission dialog nobody answered.
within() {
  local seconds=$1
  shift
  perl -e 'alarm shift; exec @ARGV; exit 127' "$seconds" "$@"
}
# The log names the account and its folders; the person pastes it to someone.
scrubbed_log() {
  tail -n 8 "$dir/sshd.log" 2>/dev/null | sed "s/$me/<用户>/g" | tr '\n' ' '
}

ssh-keygen -q -t ed25519 -N '' -f "$dir/host_key"
ssh-keygen -q -t ed25519 -N '' -f "$dir/client_key"
cp "$dir/client_key.pub" "$dir/authorized_keys"
chmod 600 "$dir/authorized_keys"

sftp_server=/usr/libexec/sftp-server
[ -x "$sftp_server" ] || sftp_server=/usr/lib/openssh/sftp-server
cat > "$dir/sshd_config" <<EOF
HostKey $dir/host_key
AuthorizedKeysFile $dir/authorized_keys
PidFile none
UsePAM no
StrictModes no
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthenticationMethods publickey
AllowUsers $me
PrintMotd no
PrintLastLog no
UseDNS no
LogLevel VERBOSE
Subsystem sftp $sftp_server
EOF

# The questions, in a file so that the terminal and the session run the very
# same thing whatever the person's login shell is.
cat > "$dir/ask.sh" <<'EOF'
#!/bin/bash
export LC_ALL=C
# Says why something failed, from what it wrote to stderr.
why() {
  case "$1" in
    *"not permitted"*) echo "被系统拦了" ;;
    *"No such file"*) echo "没有这个文件" ;;
    *"interaction is not allowed"*) echo "不行（这个会话不允许用钥匙串）" ;;
    *) echo "不行：$(printf '%s' "$1" | head -n 1 | cut -c1-100)" ;;
  esac
}
# Runs "$@" and says how it went, never what it printed.
tried() {
  local err
  if err=$("$@" 2>&1 >/dev/null); then
    echo "可以"
  else
    why "$err"
  fi
}
case "$1" in
  session) launchctl managername 2>&1 | head -n 1 ;;
  chrome) tried cat "$HOME/Library/Application Support/Google/Chrome/DevToolsActivePort" ;;
  safari) tried ls "$HOME/Library/Safari" ;;
  desktop) tried ls "$HOME/Desktop" ;;
  keychain)
    name="dodoer-probe-$$"
    if err=$(security add-generic-password -a "$name" -s "$name" -w probe 2>&1); then
      got=$(security find-generic-password -a "$name" -s "$name" -w 2>&1)
      security delete-generic-password -a "$name" -s "$name" >/dev/null 2>&1
      if [ "$got" = "probe" ]; then
        echo "可以（写入、读回、删除）"
      else
        echo "写得进，读不回：$(why "$got")"
      fi
    else
      why "$err"
    fi
    ;;
  screenshot)
    shot="$2"
    if err=$(screencapture -x -t jpg "$shot" 2>&1) && [ -s "$shot" ]; then
      echo "可以，$(($(wc -c < "$shot") / 1024))KB"
    else
      why "$err"
    fi
    rm -f "$shot"
    ;;
  open)
    if pgrep -x Calculator >/dev/null; then
      echo "计算器本来就开着，没测"
    else
      err=$(open -a Calculator 2>&1)
      sleep 3
      if pgrep -x Calculator >/dev/null; then
        echo "可以"
        pkill -x Calculator
      else
        why "$err"
      fi
    fi
    ;;
  tools)
    found=""
    for tool in git node pnpm cargo brew python3; do
      command -v "$tool" >/dev/null 2>&1 && found="$found $tool"
    done
    echo "${found:- 一个都没有}"
    ;;
esac
EOF

client_options=(
  -F /dev/null
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o IdentityAgent=none
  -o StrictHostKeyChecking=no
  -o "UserKnownHostsFile=$dir/known_hosts"
  -o LogLevel=ERROR
  -i "$dir/client_key"
)
over_pipe=(-o "ProxyCommand=$sshd -i -f $dir/sshd_config -E $dir/sshd.log")
route=("${over_pipe[@]}")
host=dodoer-probe
# Runs one command in a session; "$1" is how long to wait for it.
through() {
  local seconds=$1
  shift
  within "$seconds" ssh -n -T "${client_options[@]}" "${route[@]}" \
    -l "$me" "$host" "$@" 2>"$dir/client.err"
}

say "系统版本" "$(sw_vers -productVersion 2>/dev/null || uname -sr)"
say "SSH 版本" "$(ssh -V 2>&1 | cut -d, -f1)"

if "$sshd" -t -f "$dir/sshd_config" 2>"$dir/config.err"; then
  say "sshd 接受这份配置" "是"
else
  say "sshd 接受这份配置" "否：$(head -n 1 "$dir/config.err" | sed "s/$me/<用户>/g")"
fi

echo "接下来可能弹出几个权限询问，点「允许」或「不允许」都行，但请记下弹窗里写的是哪个 app。"

if [ "$(through 30 echo connected)" = "connected" ]; then
  say "不开端口、只服务一次连接" "可以"
else
  say "不开端口、只服务一次连接" \
    "不行：$(head -n 1 "$dir/client.err" | cut -c1-120)"
  say "sshd 的日志" "$(scrubbed_log)"
  # Tells "this Mac will not run sshd for an ordinary account at all" apart
  # from "only the pipe form fails". Loopback only, gone when the script ends.
  port=$((20000 + RANDOM % 20000))
  : > "$dir/sshd.log"
  "$sshd" -D -f "$dir/sshd_config" -E "$dir/sshd.log" \
    -o "ListenAddress=127.0.0.1" -p "$port" &
  listener=$!
  sleep 2
  route=(-o "Port=$port")
  host=127.0.0.1
  if [ "$(through 30 echo connected)" = "connected" ]; then
    say "退一步：只在本机开端口" "可以"
  else
    say "退一步：只在本机开端口" \
      "不行：$(head -n 1 "$dir/client.err" | cut -c1-120)"
    say "sshd 的日志（开端口）" "$(scrubbed_log)"
    printf '\n===== 把下面这段贴给我 =====\n%s' "$report"
    exit 1
  fi
fi

# Each question from the terminal first, then through the session: a
# difference is the session's doing, a shared refusal is the terminal's.
both() {
  local label=$1
  shift
  local direct via
  direct=$(within 60 bash "$dir/ask.sh" "$@")
  [ $? -eq 142 ] && direct="60 秒没结果（可能有弹窗没点）"
  via=$(through 60 bash "$dir/ask.sh" "$@")
  [ $? -eq 142 ] && via="60 秒没结果（可能有弹窗没点）"
  say "$label" "终端直接 = ${direct:-没有输出} ｜ 经 SSH = ${via:-没有输出}"
}

both "所在的登录会话" session
both "读 Chrome 的端口文件" chrome
both "读 Safari 的数据（要完全磁盘访问）" safari
both "读桌面文件夹" desktop
both "用钥匙串" keychain
both "截屏" screenshot "$dir/shot.jpg"

say "经 SSH 启动一个软件（计算器）" "$(through 30 bash "$dir/ask.sh" open)"
say "经 SSH 直接找得到的工具" "$(through 30 bash "$dir/ask.sh" tools)"
# What a bare `ssh host command` finds, and what the person's own shell setup
# adds to that: whether commands will have to be wrapped in a login shell.
say "经 SSH 登录环境里找得到的工具" \
  "$(through 30 "\$SHELL -lic 'bash $dir/ask.sh tools'" | tail -n 1)"

terminal=$(within 30 ssh -tt "${client_options[@]}" "${route[@]}" \
  -l "$me" "$host" tty </dev/null 2>/dev/null | tr -d '\r')
case "$terminal" in
  /dev/*) say "交互式终端" "可以" ;;
  *) say "交互式终端" "不行：${terminal:-没有输出}" ;;
esac

echo "dodoer probe $$" > "$dir/sent"
if within 30 scp -q "${client_options[@]}" "${route[@]}" \
  "$dir/sent" "$me@$host:$dir/received" 2>"$dir/client.err" &&
  cmp -s "$dir/sent" "$dir/received"; then
  say "传文件（scp）" "可以"
else
  say "传文件（scp）" "不行：$(head -n 1 "$dir/client.err" | cut -c1-120)"
fi

printf '\n===== 把下面这段贴给我 =====\n%s' "$report"
echo "另外请告诉我：弹了几个权限询问，每个弹窗里写的是哪个 app 的名字。"
