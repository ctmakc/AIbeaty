#!/usr/bin/env bash
# aibeaty-remote-watch — external probe of the public Maya demo, runs on the
# workstation from the aibeaty-remote-watch.timer (systemd --user) every 15 min.
# Probes: authed /api/platform/health + zero-LLM chat ping fast-path (sessionId
# 'watchdog-probe' -> instant 'pong', no LLM call, no conversation created).
# Two consecutive failures -> best-effort ssh restart of the box service + ONE
# alert email via formsubmit (max 1/hour). State+log: ~/.local/state/aibeaty-watch/
set -u

BASE="https://aibeaty.remolda.com"
BASIC_AUTH="demo:LuminousMaya-2026"   # demo-grade shared credentials, deliberately inline
BOX="root@46.175.145.180"
ALERT_EMAIL="ctmakc@gmail.com"

STATE_DIR="$HOME/.local/state/aibeaty-watch"
LOG_FILE="$STATE_DIR/watch.log"
FAIL_FILE="$STATE_DIR/consecutive_failures"
ALERT_FILE="$STATE_DIR/last_alert_epoch"
mkdir -p "$STATE_DIR"

log() { printf '%s %s\n' "$(date -Is)" "$*" >> "$LOG_FILE"; }

problems=()

health=$(curl -sm 10 -u "$BASIC_AUTH" "$BASE/api/platform/health" 2>/dev/null || true)
if ! grep -Eq '"ok": ?true' <<<"$health"; then
  problems+=("platform health: no ok:true (got: $(head -c 120 <<<"$health"))")
fi

pong=$(curl -sm 10 -X POST "$BASE/api/assistant/chat" \
  -H "Content-Type: application/json" \
  --data '{"sessionId":"watchdog-probe","message":"ping"}' 2>/dev/null || true)
if ! grep -Eq '"reply": ?"pong"' <<<"$pong"; then
  problems+=("assistant ping: no pong (got: $(head -c 120 <<<"$pong"))")
fi

if [ ${#problems[@]} -eq 0 ]; then
  rm -f "$FAIL_FILE"
  log "OK health+ping"
  exit 0
fi

fails=$(( $(cat "$FAIL_FILE" 2>/dev/null || echo 0) + 1 ))
printf '%s\n' "$fails" > "$FAIL_FILE"
log "FAIL ($fails consecutive): ${problems[*]}"
[ "$fails" -lt 2 ] && exit 0
printf '0\n' > "$FAIL_FILE"

log "attempting remote restart over ssh"
if timeout 30 ssh -o BatchMode=yes -o ConnectTimeout=20 "$BOX" 'systemctl restart aibeaty' >> "$LOG_FILE" 2>&1; then
  log "remote restart issued"
else
  log "remote restart FAILED (box unreachable over ssh?)"
fi

# ---- alert email, throttled to max one per hour ----
now=$(date +%s)
last_alert=$(cat "$ALERT_FILE" 2>/dev/null || echo 0)
if [ $(( now - last_alert )) -lt 3600 ]; then
  log "alert throttled (last one $(( (now - last_alert) / 60 )) min ago)"
  exit 0
fi

# formsubmit silently refuses POSTs without a browser-looking Origin/Referer.
if curl -sm 10 -X POST "https://formsubmit.co/ajax/${ALERT_EMAIL}" \
    -H "Accept: application/json" \
    -H "Origin: https://aibeaty.pages.dev" \
    -H "Referer: https://aibeaty.pages.dev/" \
    --data-urlencode "_subject=⚠️ AIbeaty demo: внешний сторожок видит сбой" \
    --data-urlencode "time=$(date -Is)" \
    --data-urlencode "message=Внешняя проверка с рабочей станции упала дважды подряд. Попытка перезапуска по ssh выполнена (см. лог)." \
    --data-urlencode "details=${problems[*]}" \
    | grep -Eqi '"success"[: ]*"?true'; then
  printf '%s\n' "$now" > "$ALERT_FILE"
  log "alert email sent"
else
  log "alert email delivery FAILED"
fi
exit 0
