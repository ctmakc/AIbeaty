#!/usr/bin/env bash
# aibeaty-remote-watch — external probe of the public Maya demo, runs on the
# workstation from the aibeaty-remote-watch.timer (systemd --user) every 15 min.
# The zero-LLM chat ping is the authoritative liveness signal. The health endpoint
# is diagnostic only: an auth-gated/stale health route must never restart a live
# assistant or generate alert mail by itself.
# Two consecutive chat-ping failures -> best-effort ssh restart of the box service
# + ONE alert email via formsubmit (max 1/hour). State+log:
# ~/.local/state/aibeaty-watch/
set -u

BASE="https://aibeaty.remolda.com"
BOX="root@46.175.145.180"
ALERT_EMAIL="ctmakc@gmail.com"

STATE_DIR="$HOME/.local/state/aibeaty-watch"
LOG_FILE="$STATE_DIR/watch.log"
FAIL_FILE="$STATE_DIR/consecutive_failures"
ALERT_FILE="$STATE_DIR/last_alert_epoch"
mkdir -p "$STATE_DIR"

log() { printf '%s %s\n' "$(date -Is)" "$*" >> "$LOG_FILE"; }

problems=()
health_problem=""

health=$(curl -sm 10 "$BASE/api/assistant/health" 2>/dev/null || true)
if ! grep -Eq '"ok": ?true' <<<"$health"; then
  health_problem="platform health: no ok:true (got: $(head -c 120 <<<"$health"))"
  log "WARN $health_problem"
fi

pong=$(curl -sm 10 -X POST "$BASE/api/assistant/chat" \
  -H "Content-Type: application/json" \
  --data '{"sessionId":"watchdog-probe","message":"ping"}' 2>/dev/null || true)
if ! grep -Eq '"reply": ?"pong"' <<<"$pong"; then
  problems+=("assistant ping: no pong (got: $(head -c 120 <<<"$pong"))")
  [ -n "$health_problem" ] && problems+=("$health_problem")
fi

if [ ${#problems[@]} -eq 0 ]; then
  rm -f "$FAIL_FILE"
  if [ -n "$health_problem" ]; then
    log "OK assistant ping; health probe degraded/auth-gated"
  else
    log "OK health+ping"
  fi
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
    --data-urlencode "message=Чат-пинг внешней проверки упал дважды подряд. Попытка перезапуска по ssh выполнена (см. лог)." \
    --data-urlencode "details=${problems[*]}" \
    | grep -Eqi '"success"[: ]*"?true'; then
  printf '%s\n' "$now" > "$ALERT_FILE"
  log "alert email sent"
else
  log "alert email delivery FAILED"
fi
exit 0
