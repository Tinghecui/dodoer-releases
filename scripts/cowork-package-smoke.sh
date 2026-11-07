#!/bin/bash
# Smoke test of the release tarball (cowork-codeg-server-linux-x64.tar.gz).
# Runs as root inside a throwaway debian:bookworm-slim container with the
# tarball mounted at /pkg.tar.gz:
#   docker run --rm -v <dist>/cowork-codeg-server-linux-x64.tar.gz:/pkg.tar.gz:ro \
#     -v <repo>/scripts:/s:ro debian:bookworm-slim bash /s/cowork-package-smoke.sh
# Installs to /usr/local/lib/cowork-codeg like Cowork does and starts the server
# with the env of deploy/server/codeg@.service (token file path, projects root,
# updates off, portal on; CODEG_BRIDGE_PORTS left unset to check that portal
# mode turns the bridge off), as an unprivileged user. Lines starting with
# "CHECK" compare against the expected value; the last line counts failures.
set -u
apt-get update -qq >/dev/null && apt-get install -y -qq curl procps ca-certificates >/dev/null 2>&1
L=/usr/local/lib/cowork-codeg
mkdir -p $L && tar -xzf /pkg.tar.gz -C $L
echo "== package: $(ls $L | tr '\n' ' ') version=$(cat $L/COWORK-VERSION)"
echo "web index: $(test -f $L/web/index.html && echo yes) title: $(grep -o '<title>[^<]*</title>' $L/web/index.html | head -1)"
for b in codeg-server codeg-mcp; do echo -n "$b missing libs: "; ldd $L/$b | grep -c 'not found'; done
id -u tester >/dev/null 2>&1 || useradd -m -u 1500 tester
H=/home/tester
TOKEN="smoke-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
# Like systemd LoadCredential: a private copy readable by the service user.
mkdir -p /run/cred && printf '%s\n' "$TOKEN" > /run/cred/token
chown tester /run/cred/token && chmod 400 /run/cred/token
P=6897
cd $H
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=$H USER=tester SHELL=/bin/bash \
  COWORK_LISTEN=127.0.0.1:$P PASEO_PASSWORD="$TOKEN" \
  CODEG_TOKEN_FILE=/run/cred/token CODEG_DATA_DIR=$H/.codeg CODEG_STATIC_DIR=$L/web \
  CODEG_PROJECTS_ROOT=$H/work CODEG_UPDATE_DISABLED=1 CODEG_COWORK_PORTAL=1 \
  setpriv --reuid=1500 --regid=1500 --clear-groups $L/codeg-server > /tmp/server.log 2>&1 &
PID=$!
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:$P/ && break; sleep 1; done
A="Authorization: Bearer $TOKEN"
c() { curl -s -o /tmp/body -w '%{http_code}' -X POST -H 'content-type: application/json' "$@"; echo " $(head -c 300 /tmp/body)"; }
FAIL=0
chk() { if [ "$2" = "$3" ]; then echo "CHECK ok   $1: $2"; else echo "CHECK FAIL $1: got '$2' want '$3'"; FAIL=$((FAIL+1)); fi; }
code() { curl -s -o /tmp/body -w '%{http_code}' -X POST -H 'content-type: application/json' "$@"; }
echo "GET / title:        $(curl -s http://127.0.0.1:$P/ | grep -o '<title>[^<]*</title>' | head -1)"
echo "GET /login:         $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$P/login)"
echo "health no auth:     $(c -d '{}' http://127.0.0.1:$P/api/health)"
echo "health sso token:   $(c -H 'Authorization: Bearer cowork-sso' -d '{}' http://127.0.0.1:$P/api/health)"
echo "health real token:  $(c -H "$A" -d '{}' http://127.0.0.1:$P/api/health)"
echo "cowork_info:        $(c -H "$A" -d '{}' http://127.0.0.1:$P/api/cowork_info)"
echo "create demo:        $(c -H "$A" -d '{"name":"demo"}' http://127.0.0.1:$P/api/cowork_create_project | head -c 120)"
echo "check_app_update:   $(c -H "$A" -d '{}' http://127.0.0.1:$P/api/check_app_update)"
P64=$(printf %s "$TOKEN" | base64 -w0 | tr '+/' '-_' | tr -d '=')
echo "ws upgrade:         $(curl -s -o /dev/null -w '%{http_code}' --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H "Sec-WebSocket-Protocol: codeg-events, codeg-token.$P64" --max-time 3 http://127.0.0.1:$P/ws/events)"
echo "== origin check (portal mode)"
H1="Host: alice.example.com:443"; XP="X-Forwarded-Proto: https"
chk "no Origin (curl / cowork-root)" "$(code -H "$A" -d '{}' http://127.0.0.1:$P/api/health)" 200
chk "own origin, direct" "$(code -H "$A" -H "Origin: http://127.0.0.1:$P" -d '{}' http://127.0.0.1:$P/api/health)" 200
chk "own origin behind nginx" "$(code -H "$A" -H "$H1" -H "$XP" -H 'Origin: https://alice.example.com' -d '{}' http://127.0.0.1:$P/api/health)" 200
chk "sibling subdomain origin" "$(code -H "$A" -H "$H1" -H "$XP" -H 'Origin: https://bob.example.com' -d '{}' http://127.0.0.1:$P/api/health)" 403
chk "foreign origin" "$(code -H "$A" -H 'Origin: https://evil.example.net' -d '{}' http://127.0.0.1:$P/api/health)" 403
chk "Origin null" "$(code -H "$A" -H 'Origin: null' -d '{}' http://127.0.0.1:$P/api/cowork_info)" 403
chk "Sec-Fetch-Site cross-site" "$(code -H "$A" -H 'Sec-Fetch-Site: cross-site' -d '{}' http://127.0.0.1:$P/api/health)" 403
chk "foreign origin, no token (403 before auth)" "$(code -H 'Origin: https://evil.example.net' -d '{}' http://127.0.0.1:$P/api/health)" 403
chk "static page with foreign origin" "$(curl -s -o /dev/null -w '%{http_code}' -H 'Origin: https://evil.example.net' http://127.0.0.1:$P/)" 200
ws() { curl -s -o /dev/null -w '%{http_code}' --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H "Sec-WebSocket-Protocol: codeg-events, codeg-token.$P64" --max-time 3 "$@" http://127.0.0.1:$P/ws/events; }
chk "ws own origin behind nginx" "$(ws -H "$H1" -H "$XP" -H 'Origin: https://alice.example.com')" 101
chk "ws sibling origin" "$(ws -H "$H1" -H "$XP" -H 'Origin: https://bob.example.com')" 403
chk "CORS preflight grants no foreign origin" "$(curl -s -i -X OPTIONS -H 'Origin: https://evil.example.net' -H 'Access-Control-Request-Method: POST' http://127.0.0.1:$P/api/health | grep -ci '^access-control-allow-origin')" 0
echo "== endpoints that would export secrets"
chk "config_sync_export_content" "$(code -H "$A" -d '{}' http://127.0.0.1:$P/api/config_sync_export_content)" 403
chk "config_sync_upload_now" "$(code -H "$A" -d '{}' http://127.0.0.1:$P/api/config_sync_upload_now)" 403
chk "backup_create_ticket" "$(code -H "$A" -d '{"includeExternalTranscripts":false}' http://127.0.0.1:$P/api/backup_create_ticket)" 403
echo "== port bridge default (portal mode)"
chk "bridge port P+1 not bound" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:$((P+1))/)" 000
echo "== redaction write paths"
chk "placeholder with nothing stored refused" "$(code -H "$A" -d '{"agentType":"gemini","enabled":true,"env":{"GEMINI_API_KEY":"********"},"modelProviderId":null}' http://127.0.0.1:$P/api/acp_update_agent_env)" 400
code -H "$A" -d '{"name":"g","apiUrl":"https://g/v1","apiKey":"grok-prov-smoke","agentType":"grok","model":null}' http://127.0.0.1:$P/api/create_model_provider >/dev/null
GP=$(grep -o '"id":[0-9]*' /tmp/body | head -1 | cut -d: -f2)
chk "bind grok to provider with redacted key" "$(code -H "$A" -d "{\"agentType\":\"grok\",\"enabled\":true,\"env\":{\"XAI_API_KEY\":\"********\",\"GROK_XAI_API_BASE_URL\":\"https://g/v1\"},\"modelProviderId\":$GP}" http://127.0.0.1:$P/api/acp_update_agent_env)" 200
sleep 1
chk "grok env holds the provider key" "$(cat $H/.codeg/codeg.db* | grep -aq '"XAI_API_KEY":"grok-prov-smoke"' && echo yes)" yes
chk "no placeholder persisted in codeg.db env" "$(cat $H/.codeg/codeg.db* | grep -ac '_KEY":"\*\*\*\*\*\*\*\*"')" 0
code -H "$A" -d '{"name":"c","apiUrl":"https://c/v1","apiKey":"claude-prov-smoke","agentType":"claude_code","model":null}' http://127.0.0.1:$P/api/create_model_provider >/dev/null
CP=$(grep -o '"id":[0-9]*' /tmp/body | head -1 | cut -d: -f2)
chk "bind claude to provider with redacted key" "$(code -H "$A" -d "{\"agentType\":\"claude_code\",\"enabled\":true,\"env\":{\"ANTHROPIC_AUTH_TOKEN\":\"********\",\"ANTHROPIC_BASE_URL\":\"https://c/v1\"},\"modelProviderId\":$CP}" http://127.0.0.1:$P/api/acp_update_agent_env)" 200
CFG='{\"env\":{\"ANTHROPIC_AUTH_TOKEN\":\"********\",\"ANTHROPIC_BASE_URL\":\"https://c/v1\"}}'
chk "claude config save with redacted key" "$(code -H "$A" -d "{\"agentType\":\"claude_code\",\"configJson\":\"$CFG\"}" http://127.0.0.1:$P/api/acp_update_agent_config)" 200
chk "~/.claude/settings.json has the real key" "$(grep -q 'claude-prov-smoke' $H/.claude/settings.json 2>/dev/null && echo yes)" yes
chk "~/.claude/settings.json has no placeholder" "$(grep -c '\*\*\*\*\*\*\*\*' $H/.claude/settings.json 2>/dev/null)" 0
code -H "$A" -d '{}' http://127.0.0.1:$P/api/acp_list_agents >/dev/null
chk "acp_list_agents leaks no provider key" "$(grep -c -e grok-prov-smoke -e claude-prov-smoke /tmp/body)" 0
SP=$(pgrep -u 1500 -f codeg-server | head -1)
echo -n "same-uid read of server environ: "; setpriv --reuid=1500 --regid=1500 --clear-groups cat /proc/$SP/environ >/dev/null 2>&1 && echo READABLE || echo denied
echo "terminal spawn:     $(c -H "$A" -d "{\"workingDir\":\"$H/work/demo\",\"shell\":\"/bin/bash\",\"initialCommand\":\"sleep 30\"}" http://127.0.0.1:$P/api/terminal_spawn)"
sleep 3
n=0
for p in $(pgrep -u 1500 | grep -vx "$SP"); do
  n=$((n+1))
  env_of() { setpriv --reuid=1500 --regid=1500 --clear-groups cat /proc/$p/environ | tr '\0' '\n'; }
  echo "descendant $p $(cat /proc/$p/comm): secret vars $(env_of | grep -cE '^(PASEO_PASSWORD|COWORK_PASSWORD|CODEG_TOKEN|COWORK_TOKEN)'), token value $(env_of | grep -c -- "$TOKEN")"
done
echo "descendants checked: $n"
echo -n "token in log: "; grep -c -- "$TOKEN" /tmp/server.log
echo "codeg-mcp runs: $($L/codeg-mcp --help >/dev/null 2>&1; echo exit=$?)"
grep -E "cowork|Token|FATAL|Listening|listening" /tmp/server.log | head -6
kill $PID; wait $PID 2>/dev/null
echo "== done, CHECK failures: $FAIL"
