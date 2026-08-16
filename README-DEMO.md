# AIbeaty — демо-запуск

Платформа: `npm run platform:serve` → http://127.0.0.1:4174 (экраны в `/screens/*.html`).
Ассистентка Майя: `docs/assistant.md` (endpoints, гейты, модель, env).
Сброс демо-данных: `npm run platform:state:reset`.

## Telegram-бот: 3 шага, ~2 минуты

Мост уже написан и оттестирован (`apps/platform/telegram-bridge.js`, zero deps,
long polling — работает из-за NAT, вебхук не нужен). Не хватает только токена.

1. **BotFather** → `/newbot` → имя «Maya · AIbeaty Demo», username вида
   `AIbeatyDemoBot` → скопировать токен.
2. **`TELEGRAM_BOT_TOKEN=<токен>` в `.env` на сервере** рядом с приложением
   (файл в `.gitignore`; токен не коммитим, не печатаем в логи — мост сам
   вырезает его из своих логов).
3. **`systemctl restart aibeaty-tg`** — бот жив. Написать ему `/start`.

Локально без systemd: `npm run assistant:telegram` (платформа должна быть
запущена; адрес переопределяется `ASSISTANT_BASE_URL`).

Что умеет мост: приветствие Майи на `/start` (честное «я ИИ» + кнопка
«поделиться номером»), «печатает…» пока думает LLM, передача номера из
contact-share в контекст клиента, вежливый фолбэк при падении LLM, тишина
при takeover (сообщения всё равно ложатся в Unified Inbox). Один токен —
один работающий мост (long poll не терпит второго слушателя).

Проверка без токена и сети: `npm run assistant:telegram:test`
(мок Telegram API + мок ассистента, 29 проверок).

### systemd-юнит (пример, `/etc/systemd/system/aibeaty-tg.service`)

```ini
[Unit]
Description=AIbeaty Telegram bridge (Maya)
After=network-online.target

[Service]
WorkingDirectory=/opt/aibeaty
EnvironmentFile=/opt/aibeaty/.env
ExecStart=/usr/bin/node apps/platform/telegram-bridge.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`WorkingDirectory`/`ExecStart` подправить под фактический путь установки
(в Docker — тот же контейнер, что и платформа: `node apps/platform/telegram-bridge.js`
вторым процессом или отдельным лёгким контейнером с тем же образом).
