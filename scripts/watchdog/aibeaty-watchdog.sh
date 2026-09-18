#!/usr/bin/env bash
# aibeaty-watchdog — local uptime guard for the Maya demo (runs ON the box).
# Driven by aibeaty-watchdog.timer every 5 minutes. Pure bash + curl, no deps.
# The zero-LLM chat ping is authoritative. The health endpoint is diagnostic only,
# because deploy drift can temporarily leave it auth-gated while chat is healthy.
# Two consecutive chat-ping failures restart aibeaty.service and send ONE alert
# email through the formsubmit relay (max 1 alert/hour).
# State lives in /run (tmpfs, resets on reboot): consecutive failure counter
# and the last-alert timestamp.
set -u

HEALTH_URL="http://127.0.0.1:4174/api/assistant/health"
CHAT_URL="http://127.0.0.1:4174/api/assistant/chat"
STATE_DIR="/run/aibeaty-watchdog"
FAIL_FILE="$STATE_DIR/consecutive_failures"
ALERT_FILE="$STATE_DIR/last_alert_epoch"
ENV_FILE="/opt/aibeaty/.env"

mkdir -p "$STATE_DIR"

health=$(curl -sm 8 "$HEALTH_URL" 2>/dev/null || true)
health_problem=""
if ! grep -Eq '"ok": ?true' <<<"$health"; then
  health_problem="health diagnostic has no ok:true (got: $(head -c 120 <<<"$health"))"
  echo "warning: $health_problem"
fi

pong=$(curl -sm 8 -X POST "$CHAT_URL" \
  -H "Content-Type: application/json" \
  --data '{"sessionId":"watchdog-local","message":"ping"}' 2>/dev/null || true)
if grep -Eq '"reply": ?"pong"' <<<"$pong"; then
  rm -f "$FAIL_FILE"
  exit 0
fi

fails=$(( $(cat "$FAIL_FILE" 2>/dev/null || echo 0) + 1 ))
printf '%s\n' "$fails" > "$FAIL_FILE"
echo "assistant ping failed ($fails consecutive): $(head -c 120 <<<"$pong")"
[ -n "$health_problem" ] && echo "$health_problem"

if [ "$fails" -lt 2 ]; then
  exit 0
fi

echo "two consecutive assistant ping failures -> restarting aibeaty.service"
systemctl restart aibeaty
printf '0\n' > "$FAIL_FILE"

# ---- alert email, throttled to max one per hour ----
now=$(date +%s)
last_alert=$(cat "$ALERT_FILE" 2>/dev/null || echo 0)
if [ $(( now - last_alert )) -lt 3600 ]; then
  echo "alert throttled (last one $(( (now - last_alert) / 60 )) min ago)"
  exit 0
fi

alert_email=$(grep -E '^ALERT_EMAIL=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2-)
[ -n "$alert_email" ] || alert_email="ctmakc@gmail.com"

# Last 10 service log lines; anything token-shaped (24+ chars of key alphabet)
# is redacted before it leaves the box.
log_tail=$(journalctl -u aibeaty -n 10 --no-pager -o cat 2>/dev/null \
  | sed -E 's/[A-Za-z0-9_/+=-]{24,}/[REDACTED]/g' \
  | head -c 1200)

# formsubmit silently refuses POSTs without a browser-looking Origin/Referer.
if curl -sm 10 -X POST "https://formsubmit.co/ajax/${alert_email}" \
    -H "Accept: application/json" \
    -H "Origin: https://aibeaty.pages.dev" \
    -H "Referer: https://aibeaty.pages.dev/" \
    --data-urlencode "_subject=⚠️ AIbeaty demo: сервис перезапущен сторожком" \
    --data-urlencode "host=$(hostname)" \
    --data-urlencode "time=$(date -Is)" \
    --data-urlencode "message=Локальный chat ping упал дважды подряд; aibeaty.service перезапущен сторожком." \
    --data-urlencode "health=${health_problem:-ok}" \
    --data-urlencode "journal_tail=${log_tail:-"(журнал пуст)"}" \
    | grep -Eqi '"success"[: ]*"?true'; then
  printf '%s\n' "$now" > "$ALERT_FILE"
  echo "alert email sent"
else
  echo "alert email delivery failed (will retry on next incident)"
fi
exit 0
