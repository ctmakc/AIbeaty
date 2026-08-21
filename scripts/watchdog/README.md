# AIbeaty uptime watchdog

Two best-effort layers keep the Maya demo alive. Zero new dependencies — bash,
curl, systemd.

## Layer 1 — on the box (root@46.175.145.180)

`aibeaty-watchdog.timer` runs `aibeaty-watchdog.sh` every 5 min:
local health probe (PUBLIC /api/assistant/health — the platform one is behind
the owner login) -> on the 2nd consecutive failure `systemctl restart aibeaty`
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
`scripts/remote-watch.sh` every 15 min: public health probe + zero-LLM
chat ping (`sessionId: watchdog-probe`, `message: ping` -> instant `pong`,
no conversation created, no quota burned). Two consecutive failures ->
best-effort ssh restart + one alert email (1/hour).
State + log: `~/.local/state/aibeaty-watch/`.

Alerts back off inside one incident (immediately, +1h, +4h, then silence until
the demo recovers, which sends one closing ✅ mail); remote restarts are capped
at 4 per incident.

Install — always through the script, never by pointing systemd at the checkout:

```bash
scripts/watchdog/install-workstation.sh
```

It copies `remote-watch.sh` to `~/.local/bin/aibeaty-remote-watch` and installs
both units. **Why a copy:** the timer used to run
`/data/projects/AIbeaty/scripts/remote-watch.sh` — a worktree parked on a branch
that does not track `scripts/`. When the probe was fixed on the deployed branch
on 2026-08-20, systemd went on executing the stale untracked leftovers there for
another day: ~29 false-alarm mails and a remote restart of a healthy demo every
30 minutes. Re-run the installer after any pull that touches the watchdog.

## Pre-demo checklist

10 minutes before the client call:

```bash
aibeaty-predemo-check
```

(installed by `install-workstation.sh` alongside the watchdog — same reason: an
ops entry point must not depend on which branch a worktree happens to hold)

Prints a ✅/❌ table: public health, TLS days left, chat ping fast-path,
widget on pages.dev, Telegram bridge, digest, today's load vs soft cap
(`PREDEMO_DAILY_CAP`, default 300). Exit code = number of failed checks.
