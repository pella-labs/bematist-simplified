# WS-20 — Manual test matrix

Unit tests exercise dispatch logic, migration, detection, and doctor checks against
in-memory fakes. Real service install is platform-specific and must be exercised by a
human on each OS before shipping a WS-20 build. This document is the script.

Each row below is one dogfood machine. Fill in the date + initials when run.

## Test fixtures

- Valid token: request an ingest key from the admin dashboard (`Admin > Ingest keys > Generate`).
  The string starts with `bm_` and ends with a long hex tail. Paste it verbatim.
- Healthy install reference API: whatever `BM_PILOT_API_URL` or the `{{API_URL}}`-
  substituted `install.sh` sets. The API must respond `200` on `GET /healthz`.

## Matrix

| OS / arch | Step | Pass? | Initials | Date |
|---|---|---|---|---|
| macOS arm64 (M1+) | `curl -fsSL .../install.sh \| sh` exits 0, binary at `~/.local/bin/bm-pilot`, config seeded with empty adapters | | | |
| macOS arm64 | `bm-pilot login <token>` prints `logged in — config saved to ...`, config file has `ingestKey` set | | | |
| macOS arm64 | `bm-pilot start` prints per-step `[ok]` for detected tools, installs hooks, writes plist, boots via `launchctl bootstrap` | | | |
| macOS arm64 | `launchctl print gui/$UID/com.bm-pilot.agent` shows `state = running`, `pid > 0` | | | |
| macOS arm64 | `bm-pilot status` JSON has `daemonRunning: true`, `serviceInstalled: true`, all `hookStates` truthy | | | |
| macOS arm64 | Kill all terminals (`killall Terminal`), log out, log back in — daemon still running | | | |
| macOS arm64 | `bm-pilot doctor` → exit 0, all `[ok]` | | | |
| macOS arm64 | `rm ~/.claude/settings.json` then `bm-pilot doctor` → exit 1, `hook:claudeCode` fail | | | |
| macOS arm64 | `bm-pilot stop` → pid no longer in `launchctl print` output | | | |
| macOS arm64 | `bm-pilot start` (rerun) → idempotent, daemon back up, no duplicate plist | | | |
| macOS arm64 | `bm-pilot stop --uninstall` → plist file removed, `launchctl print` returns non-zero | | | |
| Ubuntu 22.04 x64 | `install.sh` lands at `~/.local/bin/bm-pilot`, config seeded empty | | | |
| Ubuntu 22.04 | `bm-pilot login <token>` stores key | | | |
| Ubuntu 22.04 | `bm-pilot start` installs `~/.config/systemd/user/bm-pilot.service`, enables with `--now`, starts | | | |
| Ubuntu 22.04 | `systemctl --user status bm-pilot` is green, `MainPID` > 0 | | | |
| Ubuntu 22.04 | `bm-pilot status` → `daemonRunning: true`, `serviceInstalled: true` | | | |
| Ubuntu 22.04 | `sudo reboot` — after login, service auto-started via `systemctl --user` | | | |
| Ubuntu 22.04 | `bm-pilot doctor` → exit 0 | | | |
| Ubuntu 22.04 | `bm-pilot stop --uninstall` → unit file gone, `systemctl --user is-enabled` returns non-zero | | | |
| Windows 11 x64 | `install.sh` run under Git Bash lands binary at `~/.local/bin/bm-pilot.exe` | | | |
| Windows 11 | `bm-pilot.exe login <token>` stores key | | | |
| Windows 11 | `bm-pilot.exe start` registers the scheduled task `Bematist` (check `schtasks /Query /TN Bematist /V`) | | | |
| Windows 11 | `bm-pilot status` reports `serviceInstalled: true`, `daemonRunning: true` | | | |
| Windows 11 | Sign out + sign back in — scheduled task runs at logon, daemon back up | | | |
| Windows 11 | `bm-pilot stop --uninstall` → task gone (`schtasks /Query /TN Bematist` returns error) | | | |
| Windows 11 | Codex hook install is correctly skipped (spec: codex hooks disabled on Windows; no `~/.codex/hooks.json` written) | | | |

## Fallback path

- On a machine where the OS service install fails (e.g. no `systemctl` on an Alpine container):
  - `bm-pilot start` must print `[warn] service install failed: ...` then `[ok] fallback daemon started pid=N`.
  - `~/.bm-pilot/daemon.pid` must exist and contain the PID.
  - `bm-pilot stop` must SIGTERM the pid, wait up to 5 s, then SIGKILL; the pid file must be removed.

## Error-path checks

- `bm-pilot start` with no `ingestKey` in the config → exit 1, message points at `bm-pilot login`.
- `bm-pilot start` with a malformed token (edit config by hand) → exit 1, message explains format.
- Kill the daemon externally (`kill -9 <pid>`) → `bm-pilot doctor` surfaces `daemon not running` (non-critical), `service` still installed.
