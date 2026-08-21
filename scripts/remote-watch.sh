#!/usr/bin/env bash
# aibeaty-remote-watch — external probe of the public Maya demo, runs on the
# workstation from the aibeaty-remote-watch.timer (systemd --user) every 15 min.
#
# Probes (all PUBLIC paths — see PUBLIC_ASSISTANT_PATHS in apps/platform/server.js):
#   1. /api/assistant/health  -> ok:true
#   2. /api/assistant/chat    -> zero-LLM 'pong' fast-path (sessionId 'watchdog-probe')
#   3. GET / as a browser     -> 200, or 302 to the login page (the owner surface is alive)
#
# NOTE: do NOT probe /api/platform/health. It sits behind the owner session login
# since 2026-08-20 and answers 401 to everyone, so probing it makes the watchdog
# restart a perfectly healthy service and mail an alert every hour. That exact
# false-positive loop ran 2026-08-20..21 (~29 alert mails, a remote restart every
# 30 min) until the probes were moved to the public endpoints above.
#
# Two consecutive failures -> best-effort ssh restart of the box service + an alert
# email via formsubmit. Alerts back off inside one incident (now, +1h, +4h, then
# silence) and one "recovered" mail closes it. State+log: ~/.local/state/aibeaty-watch/
set -u

BASE="https://aibeaty.remolda.com"
BOX="root@46.175.145.180"
ALERT_EMAIL="ctmakc@gmail.com"
UA="Mozilla/5.0 (aibeaty-remote-watch)"

# Alert backoff inside a single incident: 1st mail immediately, 2nd after 1h,
# 3rd after 4h, then stay quiet until the demo recovers.
ALERT_DELAYS=(0 3600 14400)
MAX_RESTARTS_PER_INCIDENT=4

STATE_DIR="$HOME/.local/state/aibeaty-watch"
LOG_FILE="$STATE_DIR/watch.log"
FAIL_FILE="$STATE_DIR/consecutive_failures"
ALERT_FILE="$STATE_DIR/last_alert_epoch"
ALERT_COUNT_FILE="$STATE_DIR/alerts_this_incident"
RESTART_COUNT_FILE="$STATE_DIR/restarts_this_incident"
mkdir -p "$STATE_DIR"

log() { printf '%s %s\n' "$(date -Is)" "$*" >> "$LOG_FILE"; }
read_num() { cat "$1" 2>/dev/null || echo 0; }

# send_alert <subject> <message> <details>
send_alert() {
  curl -sm 10 -X POST "https://formsubmit.co/ajax/${ALERT_EMAIL}" \
    -H "Accept: application/json" \
    -H "Origin: https://aibeaty.pages.dev" \
    -H "Referer: https://aibeaty.pages.dev/" \
    --data-urlencode "_subject=$1" \
    --data-urlencode "time=$(date -Is)" \
    --data-urlencode "message=$2" \
    --data-urlencode "details=$3" \
    | grep -Eqi '"success"[: ]*"?true'
}

problems=()

health=$(curl -sm 10 -A "$UA" "$BASE/api/assistant/health" 2>/dev/null || true)
if ! grep -Eq '"ok": ?true' <<<"$health"; then
  problems+=("assistant health: no ok:true (got: $(head -c 120 <<<"$health"))")
fi

pong=$(curl -sm 10 -A "$UA" -X POST "$BASE/api/assistant/chat" \
  -H "Content-Type: application/json" \
  --data '{"sessionId":"watchdog-probe","message":"ping"}' 2>/dev/null || true)
if ! grep -Eq '"reply": ?"pong"' <<<"$pong"; then
  problems+=("assistant ping: no pong (got: $(head -c 120 <<<"$pong"))")
fi

# The owner surface: a browser GET must land on the app (200) or be redirected to
# the login page (302). Anything else means the platform itself is down.
code=$(curl -sm 10 -A "$UA" -H "Accept: text/html" -o /dev/null -w '%{http_code}' "$BASE/" 2>/dev/null)
[ -n "$code" ] || code=000
if [ "$code" != "200" ] && [ "$code" != "302" ]; then
  problems+=("owner surface: GET / returned HTTP $code (expected 200 or 302 to login)")
fi

# ---- all green ----
if [ ${#problems[@]} -eq 0 ]; then
  rm -f "$FAIL_FILE"
  if [ "$(read_num "$ALERT_COUNT_FILE")" -gt 0 ]; then
    if send_alert "✅ AIbeaty demo: сторожок видит норму" \
        "Внешняя проверка снова проходит: assistant health, ping и страница входа отвечают. Инцидент закрыт." \
        "$(tail -5 "$LOG_FILE" 2>/dev/null)"; then
      log "recovery email sent"
    else
      log "recovery email delivery FAILED"
    fi
  fi
  rm -f "$ALERT_COUNT_FILE" "$RESTART_COUNT_FILE" "$ALERT_FILE"
  log "OK health+ping+surface"
  exit 0
fi

fails=$(( $(read_num "$FAIL_FILE") + 1 ))
printf '%s\n' "$fails" > "$FAIL_FILE"
log "FAIL ($fails consecutive): ${problems[*]}"
[ "$fails" -lt 2 ] && exit 0
printf '0\n' > "$FAIL_FILE"

# ---- remediation: ssh restart, capped per incident ----
restarts=$(read_num "$RESTART_COUNT_FILE")
if [ "$restarts" -lt "$MAX_RESTARTS_PER_INCIDENT" ]; then
  printf '%s\n' "$(( restarts + 1 ))" > "$RESTART_COUNT_FILE"
  log "attempting remote restart over ssh (#$(( restarts + 1 )) this incident)"
  if timeout 30 ssh -o BatchMode=yes -o ConnectTimeout=20 "$BOX" 'systemctl restart aibeaty' >> "$LOG_FILE" 2>&1; then
    log "remote restart issued"
  else
    log "remote restart FAILED (box unreachable over ssh?)"
  fi
else
  log "restart cap reached ($MAX_RESTARTS_PER_INCIDENT this incident) — manual attention needed"
fi

# ---- alert email, backing off inside the incident ----
alerts=$(read_num "$ALERT_COUNT_FILE")
if [ "$alerts" -ge "${#ALERT_DELAYS[@]}" ]; then
  log "alert suppressed (already sent $alerts this incident; quiet until recovery)"
  exit 0
fi

now=$(date +%s)
last_alert=$(read_num "$ALERT_FILE")
need=${ALERT_DELAYS[$alerts]}
if [ "$alerts" -gt 0 ] && [ $(( now - last_alert )) -lt "$need" ]; then
  log "alert throttled (next one in $(( (need - (now - last_alert)) / 60 )) min)"
  exit 0
fi

if send_alert "⚠️ AIbeaty demo: внешний сторожок видит сбой" \
    "Внешняя проверка с рабочей станции упала дважды подряд. Попытка перезапуска по ssh выполнена (см. лог). Это письмо $(( alerts + 1 )) из ${#ALERT_DELAYS[@]} по этому инциденту." \
    "${problems[*]}"; then
  printf '%s\n' "$now" > "$ALERT_FILE"
  printf '%s\n' "$(( alerts + 1 ))" > "$ALERT_COUNT_FILE"
  log "alert email sent ($(( alerts + 1 ))/${#ALERT_DELAYS[@]} this incident)"
else
  log "alert email delivery FAILED"
fi
exit 0
