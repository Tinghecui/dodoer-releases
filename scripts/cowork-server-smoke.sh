#!/bin/bash
# Smoke test for the Cowork fork's codeg-server env contract (see COWORK.md).
# Runs as root inside a throwaway rust:slim-bookworm container where the repo is
# mounted at /app and `cargo build --no-default-features --features server-bin
# --bin codeg-server` has already been run:
#   apt-get update -qq && bash /app/scripts/cowork-server-smoke.sh
# It creates a user `tester` (uid 1500) and listens on 127.0.0.1:6899.
set -u
apt-get install -y -qq curl procps git >/dev/null 2>&1
BIN=/app/src-tauri/target/debug/codeg-server
id -u tester >/dev/null 2>&1 || useradd -m -u 1500 tester
H=/home/tester
rm -rf $H/.codeg $H/work
mkdir -p /etc/cw && TOKEN="smoke-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
printf '%s\n' "$TOKEN" > /etc/cw/token; chmod 600 /etc/cw/token; chown root:root /etc/cw/token
echo "== start (token on stdin from a root-600 file, run as uid 1500)"
cd $H
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=$H USER=tester \
  COWORK_DATA_DIR=$H/.codeg COWORK_PROJECTS_ROOT=$H/work COWORK_UPDATE_DISABLED=1 CODEG_COWORK_PORTAL=1 \
  CODEG_BRIDGE_PORTS=off PASEO_LISTEN=127.0.0.1:6899 PASEO_PASSWORD="$TOKEN" COWORK_TOKEN_FILE=- \
  setpriv --reuid=1500 --regid=1500 --clear-groups $BIN < /etc/cw/token > /tmp/server.log 2>&1 &
PID=$!
for i in $(seq 1 120); do curl -s -o /dev/null http://127.0.0.1:6899/ && break; sleep 1; done
A="Authorization: Bearer $TOKEN"
c() { curl -s -o /tmp/body -w '%{http_code}' -X POST -H 'content-type: application/json' "$@"; echo " $(head -c 400 /tmp/body)"; }
echo "health no auth:     $(c http://127.0.0.1:6899/api/health)"
echo "health sso token:   $(c -H 'Authorization: Bearer cowork-sso' http://127.0.0.1:6899/api/health)"
echo "health real token:  $(c -H "$A" http://127.0.0.1:6899/api/health)"
echo "cowork_info noauth: $(c -d '{}' http://127.0.0.1:6899/api/cowork_info)"
echo "cowork_info:        $(c -H "$A" -d '{}' http://127.0.0.1:6899/api/cowork_info)"
echo "create demo:        $(c -H "$A" -d '{"name":"demo"}' http://127.0.0.1:6899/api/cowork_create_project)"
# A new project is a git repository: HEAD on main, one empty "Initial commit"
# by the fallback identity (tester <tester@localhost>: no git config here).
echo "demo HEAD:          $(cat $H/work/demo/.git/HEAD 2>&1)"
echo "demo commits:       $(setpriv --reuid=1500 --regid=1500 --clear-groups env HOME=$H git -C $H/work/demo log --format='%s <%an %ae>' 2>&1 | tr '\n' ' ')"
echo "demo git config:    $(grep -c '^\[user\]' $H/work/demo/.git/config 2>&1) [user] section(s), $(test -e $H/.gitconfig && echo "a ~/.gitconfig" || echo "no ~/.gitconfig")"
# The same name again is a conflict (409 already_exists, i18n_key
# cowork.projectExists): the existing directory is not reused or touched.
echo "create demo again:  $(c -H "$A" -d '{"name":"demo"}' http://127.0.0.1:6899/api/cowork_create_project)"
echo "demo after 409:     $(ls -A $H/work/demo | tr '\n' ' ')"
echo "create ../x:        $(c -H "$A" -d '{"name":"../x"}' http://127.0.0.1:6899/api/cowork_create_project)"
touch $H/work/afile
echo "create afile:       $(c -H "$A" -d '{"name":"afile"}' http://127.0.0.1:6899/api/cowork_create_project)"
echo "list folders:       $(c -H "$A" -d '{}' http://127.0.0.1:6899/api/list_open_folder_details | head -c 200)"
echo "check_app_update:   $(c -H "$A" -d '{}' http://127.0.0.1:6899/api/check_app_update)"
echo "perform_app_update: $(c -H "$A" -d '{}' http://127.0.0.1:6899/api/perform_app_update)"
echo "app_update_status:  $(c -H "$A" -d '{}' http://127.0.0.1:6899/api/app_update_status)"
echo "web server status:  $(c -H "$A" -d '{}' http://127.0.0.1:6899/api/get_web_server_status)"
P64=$(printf %s "$TOKEN" | base64 -w0 | tr '+/' '-_' | tr -d '=')
echo "ws upgrade (token subprotocol): $(curl -s -o /dev/null -w '%{http_code}' --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H "Sec-WebSocket-Protocol: codeg-events, codeg-token.$P64" --max-time 3 http://127.0.0.1:6899/ws/events)"
echo "== redaction"
echo "set env:            $(c -H "$A" -d "{\"agentType\":\"grok\",\"enabled\":true,\"env\":{\"XAI_API_KEY\":\"xai-smoke-secret\",\"GROK_MODELS_BASE_URL\":\"https://x/v1\"},\"modelProviderId\":null}" http://127.0.0.1:6899/api/acp_update_agent_env)"
c -H "$A" -d "{}" http://127.0.0.1:6899/api/acp_list_agents >/dev/null
echo -n "list_agents leaks secret: "; grep -c xai-smoke-secret /tmp/body
echo -n "list_agents grok XAI_API_KEY: "; grep -o "\"XAI_API_KEY\":\"[^\"]*\"" /tmp/body | head -1
echo "echo env back:      $(c -H "$A" -d "{\"agentType\":\"grok\",\"enabled\":true,\"env\":{\"XAI_API_KEY\":\"********\",\"GROK_MODELS_BASE_URL\":\"https://y/v1\"},\"modelProviderId\":null}" http://127.0.0.1:6899/api/acp_update_agent_env)"
sleep 1
echo -n "secret still stored in db: "; cat $H/.codeg/codeg.db* | grep -ac xai-smoke-secret
echo "create provider:    $(c -H "$A" -d "{\"name\":\"p\",\"apiUrl\":\"https://x/v1\",\"apiKey\":\"prov-smoke-secret\",\"agentType\":\"grok\",\"model\":null}" http://127.0.0.1:6899/api/create_model_provider)"
echo "list providers:     $(c -H "$A" -d "{}" http://127.0.0.1:6899/api/list_model_providers)"
echo "create w/ mask:     $(c -H "$A" -d "{\"name\":\"q\",\"apiUrl\":\"u\",\"apiKey\":\"********\",\"agentType\":\"grok\",\"model\":null}" http://127.0.0.1:6899/api/create_model_provider)"
echo "web service config: $(c -H "$A" -d "{}" http://127.0.0.1:6899/api/get_web_service_config)"
echo "restart_app:        $(c -H "$A" -d "{}" http://127.0.0.1:6899/api/restart_app)"
echo "db modes: $(stat -c "%n %a" $H/.codeg/codeg.db* | sed "s#$H/.codeg/##" | tr "\n" " ")"
echo "== process checks"
SP=$(pgrep -u 1500 -f codeg-server | head -1)
echo "server pid $SP, uid $(stat -c %u /proc/$SP)"
echo "dumpable owner of /proc/pid/environ: $(stat -c %U /proc/$SP/environ)"
echo -n "same-uid read of /proc/pid/environ: "; setpriv --reuid=1500 --regid=1500 --clear-groups cat /proc/$SP/environ >/dev/null 2>&1 && echo READABLE || echo denied
echo -n "same-uid read of token file: "; setpriv --reuid=1500 --regid=1500 --clear-groups cat /etc/cw/token >/dev/null 2>&1 && echo READABLE || echo denied
echo "server fd0 -> $(readlink /proc/$SP/fd/0)"
echo "projects root exists: $(test -d $H/work && echo yes) owner $(stat -c %U $H/work)"
echo "children of server:"; ps --ppid $SP -o pid=,comm= || true
for c in $(ps --ppid $SP -o pid=); do echo -n "child $c secrets in environ: "; tr '\0' '\n' < /proc/$c/environ | grep -cE '^(PASEO_PASSWORD|COWORK_PASSWORD|CODEG_TOKEN|COWORK_TOKEN)' ; done
echo "terminal spawn:     $(c -H "$A" -d "{\"workingDir\":\"$H/work/demo\",\"shell\":\"/bin/bash\",\"initialCommand\":\"sleep 30\"}" http://127.0.0.1:6899/api/terminal_spawn)"
sleep 3
for p in $(pgrep -u 1500 | grep -vx "$SP"); do echo -n "descendant $p $(cat /proc/$p/comm) secrets in environ: "; setpriv --reuid=1500 --regid=1500 --clear-groups cat /proc/$p/environ | tr "\0" "\n" | grep -cE "^(PASEO_PASSWORD|COWORK_PASSWORD|CODEG_TOKEN|COWORK_TOKEN)"; echo -n "  token value in environ: "; setpriv --reuid=1500 --regid=1500 --clear-groups cat /proc/$p/environ | tr "\0" "\n" | grep -c -- "$TOKEN"; done
echo -n "token in log: "; grep -c "$TOKEN" /tmp/server.log
echo "== log tail"; grep -E "cowork|Token|FATAL|Listening" /tmp/server.log | head
echo "== graceful stop (SIGTERM)"
T0=$(date +%s); kill -TERM $PID; wait $PID 2>/dev/null; echo "SIGTERM exit=$? after $(( $(date +%s) - T0 ))s"
echo -n "graceful stop logged: "; grep -c "\[cowork\] stop" /tmp/server.log
echo "== fail-closed: missing token file"
env -i PATH=/usr/bin:/bin HOME=$H CODEG_DATA_DIR=/tmp/d2 CODEG_PORT=6898 CODEG_HOST=127.0.0.1 CODEG_TOKEN_FILE=/nonexistent timeout 20 $BIN; echo "exit=$?"
