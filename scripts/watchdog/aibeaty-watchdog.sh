#!/usr/bin/env bash
# aibeaty-watchdog — local uptime guard for the Maya demo (runs ON the box).
# Driven by aibeaty-watchdog.timer every 5 minutes. Pure bash + curl, no deps.
# Logic: health probe -> on the 2nd consecutive failure restart aibeaty.service
# and send ONE alert email through the formsubmit relay (max 1 alert/hour).
# State lives in /run (tmpfs, resets on reboot): consecutive failure counter
# and the last-alert timestamp.
set -u

# Liveness probe must be a PUBLIC path: /api/platform/health sits behind the owner
# login since 2026-08-20, and a probe that gets 401 would restart a healthy service.
HEALTH_URL="http://127.0.0.1:4174/api/assistant/health"
STATE_DIR="/run/aibeaty-watchdog"
FAIL_FILE="$STATE_DIR/consecutive_failures"
ALERT_FILE="$STATE_DIR/last_alert_epoch"
ENV_FILE="/opt/aibeaty/.env"

mkdir -p "$STATE_DIR"

if curl -sm 8 "$HEALTH_URL" | grep -Eq '"ok": ?true'; then
  rm -f "$FAIL_FILE"
  exit 0
fi

fails=$(( $(cat "$FAIL_FILE" 2>/dev/null || echo 0) + 1 ))
printf '%s\n' "$fails" > "$FAIL_FILE"
echo "health check failed ($fails consecutive)"

if [ "$fails" -lt 2 ]; then
  exit 0
fi

echo "two consecutive failures -> restarting aibeaty.service"
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
    --data-urlencode "message=Локальный health-check упал дважды подряд; aibeaty.service перезапущен сторожком." \
    --data-urlencode "journal_tail=${log_tail:-"(журнал пуст)"}" \
    | grep -Eqi '"success"[: ]*"?true'; then
  printf '%s\n' "$now" > "$ALERT_FILE"
  echo "alert email sent"
else
  echo "alert email delivery failed (will retry on next incident)"
fi
exit 0
