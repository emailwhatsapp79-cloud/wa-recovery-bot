# WA Recovery — multi-user (invite-only)

One server, many people. Each user links their own WhatsApp and gets their own
deleted/edited-message recovery, `.vv` / `.vvc` view-once saving, settings and activity log.

## What's inside
| File | Job |
|---|---|
| `server.js` | Web server: landing, sign up, log in, dashboard, admin; starts everyone's WhatsApp |
| `src/sessions.js` | One WhatsApp connection per user + all recovery logic and commands |
| `src/media.js` | Saves media to disk as it arrives (streamed, size-capped, auto-cleaned) |
| `src/db.js` | Accounts + invite codes (`data/db.json`) |
| `src/auth.js` | Password hashing, login cookies, brute-force limit |
| `src/userdata.js` | Per-user folders, settings, activity/error log |
| `src/pages.js` | The HTML pages |
| `src/backup.js` | Daily backups (accounts, logins, settings; not media), last 7 kept |
| `src/alerts.js` | WhatsApp alerts to admin/user when a link drops or errors pile up |
| `src/adminsettings.js` | Admin switches for alerts and backups |
| `scripts/deploy.sh` | Install/update on the Oracle server |
| `scripts/import-old-session.sh` | Move your current WhatsApp login into your new account |

All data lives in `data/` (back it up; never share it — it contains WhatsApp logins).

## Deploy (on the Oracle server)
1. Copy `wa-multi.tar.gz` and `scripts/deploy.sh` to the server's `/tmp/`.
2. `sudo bash /tmp/deploy.sh /tmp/wa-multi.tar.gz`
3. It prints a **first admin invite code**. Open the site → Sign up → use it. That account is the admin.
4. Optional: keep your current WhatsApp link instead of re-linking:
   `sudo bash /var/lib/ocarun/wa-multi/scripts/import-old-session.sh you@example.com`
5. Admin page → Create invite code → send it to a friend.

Rollback: `pm2 delete wa-multi` then start the old bot again (its folder is untouched).

## Commands (each user, in WhatsApp)
`.vv` (reply to view-once → to you) · `.vvc` (→ into that chat) · `.ping` · `.help` ·
`.ad status` · `.ad on|off [type]` · `.ad reset` ·
`.block [30m|2h|1d|1w]` (blocks on WhatsApp, unblocks by itself when the time is up; reply to someone, send it in their chat, or add a number) · `.unblock` · `.block list` ·
`.admins message` (in a group: posts it with only the admins tagged) ·
`.transcribe` (reply to a voice note; needs a Gemini key on the admin page)

Recovery counts are kept in `data/users/<id>/stats.json`, so they survive restarts.
Statuses have two switches: **Deleted statuses** and **Edited statuses** (both off by default).

## Updates (automatic)
Push to `main` → GitHub Actions builds `wa-multi.tar.gz` (code + node_modules) as a release →
the server's `scripts/auto-update.sh` (cron, every 5 min, as `ocarun`) installs it and restarts `wa-multi`.
It rolls back by itself if the new version doesn't start. Needs a read-only GitHub token pasted on
**Admin → System → Keys and updates**. Log: `data/auto-update.log`.

## Limits (change with environment variables)
`MAX_USERS=30` · `MEDIA_MAX_MB=64` per file · `MEDIA_KEEP_HOURS=72` · `MEDIA_USER_CAP_MB=600` per user · `PORT=8080`

## Notes
- Unofficial: connects as a WhatsApp linked device. WhatsApp can restrict accounts using unofficial tools.
- WhatsApp usually hides view-once media from linked devices, so automatic saving may not get them; `.vv` works.
- Rough capacity: each linked user uses ~100–200 MB RAM. 10 GB server ≈ 30–50 users.

## Backups
Daily ~03:00 into `data/backups/` (last 7). Admin page: Back up now, Download, or send each backup to your WhatsApp.
Restore on a new server: install the app, stop it, then `tar -xzf backup-XXXX.tar.gz -C /var/lib/ocarun/wa-multi/data` and start it again.
Backups contain everyone's WhatsApp logins: keep them private.

## Alerts
Sent from the admin's WhatsApp (admin must be linked): user logged out (also tells the user), offline 10+ min,
another copy connected, 5+ errors in 10 min, back online. Max once per 6 hours per user per kind.
