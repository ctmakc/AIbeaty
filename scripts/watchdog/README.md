# AIbeaty uptime watchdog

Two best-effort layers keep the Maya demo alive. Zero new dependencies — bash,
curl, systemd.

The zero-LLM assistant chat ping is the authoritative liveness signal for both
layers. `/api/assistant/health` is still collected as a diagnostic, but a 401 or
other health-only failure does not restart a healthy service and does not send an
alert. This avoids false restart/email loops when a deploy leaves the health route
auth-gated while the public assistant endpoint is working.

## Layer 1 — on the box (root@46.175.145.180)

`aibeaty-watchdog.timer` runs `aibeaty-watchdog.sh` every 5 min:
local zero-LLM chat ping (`sessionId: watchdog-local`, `message: ping` -> instant
`pong`, no conversation or LLM call), with `/api/assistant/health` recorded as a
diagnostic. On the 2nd consecutive chat-ping failure it runs
`systemctl restart aibeaty` plus one alert email via the formsubmit relay
(throttled to 1/hour). State: `/run/aibeaty-watchdog/`. Logs:
`journalctl -u aibeaty-watchdog`.

Install (after `git pull` in /opt/aibeaty):

```bash
cp /opt/aibeaty/scripts/watchdog/aibeaty-watchdog.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now aibeaty-watchdog.timer
```

## Layer 2 — on the workstation

`aibeaty-remote-watch.timer` (systemd **--user**) runs
`scripts/remote-watch.sh` every 15 min: zero-LLM chat ping
(`sessionId: watchdog-probe`, `message: ping` -> instant `pong`, no conversation
created, no quota burned) plus a diagnostic public-health probe. Two consecutive
chat-ping failures -> best-effort ssh restart + one alert email (1/hour). A
health-only failure is logged as WARN and does not count toward the failure
counter. State + log: `~/.local/state/aibeaty-watch/`.

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
