#!/usr/bin/env bash
# predemo-check — прогон за 10 минут до звонка с клиентом.
# Запуск с рабочей станции: /data/projects/AIbeaty/scripts/predemo-check.sh
# Печатает таблицу ✅/❌; код выхода = число проваленных проверок.
set -u

BASE="https://aibeaty.remolda.com"
HOST="aibeaty.remolda.com"
PAGES="https://aibeaty.pages.dev"
BOX="root@46.175.145.180"
DAILY_CAP="${PREDEMO_DAILY_CAP:-300}" # мягкий потолок ответов Майи в день (квота Ollama Cloud общая)

rows=()
fail=0
add() { # $1 = 0|1 (ok/fail), $2 = name, $3 = detail
  if [ "$1" -eq 0 ]; then rows+=("✅  $2 — $3"); else rows+=("❌  $2 — $3"); fail=$((fail+1)); fi
}

# 1. Публичный health (открыт всем — им же живёт сторожок)
health=$(curl -sm 10 "$BASE/api/assistant/health" 2>/dev/null || true)
if grep -Eq '"ok": ?true' <<<"$health"; then
  add 0 "Health $HOST" "ok:true"
else
  add 1 "Health $HOST" "нет ok:true (получено: $(head -c 100 <<<"$health"))"
fi

# 1b. Страница входа отдаётся и выглядит как форма (клиент видит её первой)
login_body=$(curl -sm 10 "$BASE/screens/login.html" 2>/dev/null || true)
if grep -q 'id="login-form"' <<<"$login_body" && grep -q 'Вход в кабинет' <<<"$login_body"; then
  add 0 "Страница входа" "форма отдаётся, $(wc -c <<<"$login_body") байт"
else
  add 1 "Страница входа" "нет формы входа по $BASE/screens/login.html"
fi

# 1c. Замок закрыт: кабинет без входа не отдаёт данные
gate_api=$(curl -sm 10 -o /dev/null -w '%{http_code}' "$BASE/api/platform/health" 2>/dev/null || echo 000)
gate_screen=$(curl -sm 10 -o /dev/null -w '%{http_code}' -H 'Accept: text/html' \
  "$BASE/screens/salon-performance-luminous-core.html" 2>/dev/null || echo 000)
if [ "$gate_api" = "401" ] && [ "$gate_screen" = "302" ]; then
  add 0 "Замок кабинета" "без входа API=401, экран=302 на форму входа"
else
  add 1 "Замок кабинета" "ожидали 401/302, получили API=$gate_api экран=$gate_screen"
fi

# 1d. Приём логина жив (заведомо неверный пароль обязан получить 401, а не 500)
bad_login=$(curl -sm 10 -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' --data '{"email":"predemo@probe.invalid","password":"wrong-on-purpose"}' 2>/dev/null || echo 000)
if [ "$bad_login" = "401" ] || [ "$bad_login" = "429" ]; then
  add 0 "Приём логина" "отвечает $bad_login на заведомо неверный пароль"
else
  add 1 "Приём логина" "ожидали 401, получили $bad_login"
fi

# 2. TLS: сколько дней осталось сертификату
not_after=$(echo | timeout 15 openssl s_client -servername "$HOST" -connect "$HOST:443" 2>/dev/null \
  | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
if [ -n "$not_after" ]; then
  days=$(( ( $(date -d "$not_after" +%s) - $(date +%s) ) / 86400 ))
  if [ "$days" -ge 7 ]; then add 0 "TLS-сертификат" "ещё $days дн."; else add 1 "TLS-сертификат" "осталось всего $days дн."; fi
else
  add 1 "TLS-сертификат" "не удалось прочитать срок действия"
fi

# 3. Чат-пинг (zero-LLM fast-path, не создаёт диалогов и не жжёт квоту)
pong=$(curl -sm 10 -X POST "$BASE/api/assistant/chat" -H "Content-Type: application/json" \
  --data '{"sessionId":"watchdog-predemo","message":"ping"}' 2>/dev/null || true)
if grep -Eq '"reply": ?"pong"' <<<"$pong"; then
  add 0 "Чат Майи (ping)" "pong, мгновенно, без LLM"
else
  add 1 "Чат Майи (ping)" "нет pong (получено: $(head -c 100 <<<"$pong"))"
fi

# 4. Виджет на pages.dev
widget_code=$(curl -sm 10 -o /dev/null -w '%{http_code}' "$PAGES/assistant-widget.js" 2>/dev/null || echo 000)
widget_size=$(curl -sm 10 "$PAGES/assistant-widget.js" 2>/dev/null | wc -c)
if [ "$widget_code" = "200" ] && [ "$widget_size" -gt 1000 ]; then
  add 0 "Виджет $PAGES" "HTTP 200, $widget_size байт"
else
  add 1 "Виджет $PAGES" "HTTP $widget_code, $widget_size байт"
fi

# 5. Telegram-мост на боксе
tg_state=$(timeout 30 ssh -o BatchMode=yes -o ConnectTimeout=20 "$BOX" 'systemctl is-active aibeaty-tg' 2>/dev/null || echo unreachable)
if [ "$tg_state" = "active" ]; then
  add 0 "Telegram-мост (@aibeaty_maya_bot)" "active"
else
  add 1 "Telegram-мост (@aibeaty_maya_bot)" "состояние: $tg_state"
fi

# 6. Дайджест
digest=$(curl -sm 10 "$BASE/api/assistant/digest" 2>/dev/null || true)
if grep -q '"day"' <<<"$digest" && grep -q '"totals"' <<<"$digest"; then
  add 0 "Дайджест /api/assistant/digest" "отдаёт день $(grep -o '"day": "[^"]*"' <<<"$digest" | head -1 | cut -d'"' -f4)"
else
  add 1 "Дайджест /api/assistant/digest" "нет корректного JSON"
fi

# 7. Сегодняшняя нагрузка vs мягкий потолок
replies=$(grep -o '"assistantReplies": [0-9]*' <<<"$digest" | grep -o '[0-9]*' | head -1)
if [ -n "${replies:-}" ]; then
  if [ "$replies" -lt "$DAILY_CAP" ]; then
    add 0 "Нагрузка сегодня" "$replies ответов Майи (потолок $DAILY_CAP)"
  else
    add 1 "Нагрузка сегодня" "$replies ответов — выше потолка $DAILY_CAP, квота LLM под угрозой"
  fi
else
  add 1 "Нагрузка сегодня" "не удалось прочитать assistantReplies из дайджеста"
fi

echo "────────  AIbeaty pre-demo check  ────────"
printf '%s\n' "${rows[@]}"
echo "──────────────────────────────────────────"
if [ "$fail" -eq 0 ]; then
  echo "ALL GREEN — можно звонить клиенту."
else
  echo "$fail пункт(ов) красные — чинить до звонка."
fi
exit "$fail"
