#!/usr/bin/env bash
# install-workstation — put the remote watchdog in place on the workstation.
#
# The script is COPIED to ~/.local/bin instead of being run from the checkout.
# A git worktree is not a stable install target: on 2026-08-20 the deployed
# branch fixed the health probe, but the timer pointed at
# /data/projects/AIbeaty/scripts/remote-watch.sh — a worktree parked on a branch
# that does not track scripts/ at all — so systemd kept executing the stale
# untracked leftovers for another day (~29 false alarm mails, a remote restart
# every 30 min). Run this after every pull that touches the watchdog.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
bin_dir="$HOME/.local/bin"
unit_dir="$HOME/.config/systemd/user"
mkdir -p "$bin_dir" "$unit_dir"

install -m 755 "$repo_root/scripts/remote-watch.sh" "$bin_dir/aibeaty-remote-watch"
install -m 755 "$repo_root/scripts/predemo-check.sh" "$bin_dir/aibeaty-predemo-check"
install -m 644 "$repo_root/scripts/watchdog/aibeaty-remote-watch.service" "$unit_dir/"
install -m 644 "$repo_root/scripts/watchdog/aibeaty-remote-watch.timer" "$unit_dir/"

systemctl --user daemon-reload
systemctl --user enable --now aibeaty-remote-watch.timer

printf 'installed: %s\n' "$bin_dir/aibeaty-remote-watch" "$bin_dir/aibeaty-predemo-check"
printf 'source: %s\n' "$repo_root"
systemctl --user list-timers aibeaty-remote-watch.timer --no-pager | sed -n 2p
