# AIbeaty uptime watchdog

Two best-effort layers keep the Maya demo alive. Zero new dependencies — bash,
curl, systemd.

## Layer 1 — on the box (root@46.175.145.180)

`aibeaty-watchdog.timer` runs `aibeaty-watchdog.sh` every 5 min:
local health probe -> on the 2nd consecutive failure `systemctl restart aibeaty`
plus one alert email via the formsubmit relay (throttled to 1/hour).
State: `/run/aibeaty-watchdog/`. Logs: `journalctl -u aibeaty-watchdog`.

Install (after `git pull` in /opt/aibeaty):

```bash
cp /opt/aibeaty/scripts/watchdog/aibeaty-watchdog.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now aibeaty-watchdog.timer
```

## Layer 2 — on the workstation

`aibeaty-remote-watch.timer` (systemd **--user**) runs
`scripts/remote-watch.sh` every 15 min: authed public health probe + zero-LLM
chat ping (`sessionId: watchdog-probe`, `message: ping` -> instant `pong`,
no conversation created, no quota burned). Two consecutive failures ->
best-effort ssh restart + one alert email (1/hour).
State + log: `~/.local/state/aibeaty-watch/`.

Install:

```bash
cp scripts/watchdog/aibeaty-remote-watch.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now aibeaty-remote-watch.timer
```

## Pre-demo checklist

10 minutes before the client call:

```bash
/data/projects/AIbeaty/scripts/predemo-check.sh
```

Prints a ✅/❌ table: public health, TLS days left, chat ping fast-path,
widget on pages.dev, Telegram bridge, digest, today's load vs soft cap
(`PREDEMO_DAILY_CAP`, default 300). Exit code = number of failed checks.
