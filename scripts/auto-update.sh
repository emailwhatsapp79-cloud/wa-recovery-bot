#!/bin/bash
# Auto-update: installs the newest GitHub release of this app, then restarts it.
#
# Runs every 5 minutes from cron, as the same user the app runs as (ocarun). No root needed.
# - Needs a GitHub token in data/update.token (paste it on the admin page -> System -> Keys and updates).
# - data/ (accounts, WhatsApp logins, settings) is never touched.
# - If the new version doesn't come up within ~45 s, the previous version is put back
#   and that release is skipped until a newer one appears.
# - Log: data/auto-update.log (last lines are shown on the admin page).
set -uo pipefail

REPO=emailwhatsapp79-cloud/wa-recovery-bot
BASE=${WA_BASE:-/var/lib/ocarun}
APP=$BASE/wa-multi
DATA=$APP/data
PM2_NAME=wa-multi
PORT=${PORT:-8080}
LOG=$DATA/auto-update.log
BAD=$BASE/.wa-update-bad
ITEMS="server.js src scripts node_modules package.json package-lock.json README.md .release-tag"

export HOME=$BASE PM2_HOME=$BASE/.pm2 PATH=$BASE/node/bin:/usr/local/bin:/usr/bin:/bin

log() { echo "$(date -u '+%Y-%m-%d %H:%M UTC') $*" >> "$LOG"; }
finish() {
  [ -n "${WORK:-}" ] && rm -rf "$WORK"
  [ -f "$LOG" ] && tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
}
trap finish EXIT

# only one run at a time
exec 9>"$BASE/.wa-update.lock"
flock -n 9 || exit 0

[ -s "$DATA/update.token" ] || exit 0          # not set up yet: do nothing
TOKEN=$(tr -d '[:space:]' < "$DATA/update.token")
API=https://api.github.com/repos/$REPO
gh() { curl -fsS --max-time 60 -H "Authorization: Bearer $TOKEN" -H "X-GitHub-Api-Version: 2022-11-28" "$@"; }

if ! JSON=$(gh -H "Accept: application/vnd.github+json" "$API/releases/latest" 2>&1); then
  # log a failed check at most once an hour, so the log isn't flooded
  [ "$(date +%M)" -lt 5 ] && log "Couldn't check GitHub for updates (token expired or wrong?): ${JSON:0:120}"
  exit 1
fi
read -r TAG ASSET < <(printf '%s' "$JSON" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const r = JSON.parse(s); const a = (r.assets || []).find((x) => x.name === "wa-multi.tar.gz");
    console.log((r.tag_name || "-") + " " + (a ? a.id : "-"));
  });')
[ "$TAG" != "-" ] && [ "$ASSET" != "-" ] || exit 0

CUR=$(cat "$APP/.release-tag" 2>/dev/null || echo "manual install")
[ "$TAG" = "$CUR" ] && exit 0
[ "$(cat "$BAD" 2>/dev/null)" = "$TAG" ] && exit 0

log "Updating: $CUR -> $TAG"
WORK=$(mktemp -d "$BASE/.wa-update.XXXXXX")
if ! gh -L -H "Accept: application/octet-stream" "$API/releases/assets/$ASSET" -o "$WORK/bundle.tgz"; then
  log "Download failed; will try again in 5 minutes."; exit 1
fi
mkdir "$WORK/new" "$WORK/old"
if ! tar -xzf "$WORK/bundle.tgz" -C "$WORK/new" || ! (cd "$WORK/new" && node --check server.js); then
  log "$TAG is broken (bad bundle or syntax error). Skipped."; echo "$TAG" > "$BAD"; exit 1
fi

healthy() {
  for _ in $(seq 1 15); do
    sleep 3
    if pm2 jlist 2>/dev/null | node -e '
        let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
          const p = JSON.parse(s || "[]").find((x) => x.name === process.argv[1]);
          process.exit(p && p.pm2_env.status === "online" ? 0 : 1);
        });' "$PM2_NAME" && curl -fs -o /dev/null --max-time 5 "http://127.0.0.1:$PORT/"; then
      return 0
    fi
  done
  return 1
}

# swap old code out, new code in (data/ stays where it is)
for i in $ITEMS; do
  [ -e "$APP/$i" ] && mv "$APP/$i" "$WORK/old/"
  [ -e "$WORK/new/$i" ] && mv "$WORK/new/$i" "$APP/"
done
pm2 restart "$PM2_NAME" >/dev/null 2>&1

if healthy; then
  pm2 save >/dev/null 2>&1
  log "Updated to $TAG. Running fine."
  exit 0
fi

log "$TAG didn't start properly. Rolling back to $CUR."
for i in $ITEMS; do
  rm -rf "${APP:?}/$i"
  [ -e "$WORK/old/$i" ] && mv "$WORK/old/$i" "$APP/"
done
pm2 restart "$PM2_NAME" >/dev/null 2>&1
echo "$TAG" > "$BAD"
if healthy; then log "Rolled back to $CUR. Running fine."; else log "Rollback to $CUR also failed to start. Check: pm2 logs $PM2_NAME"; fi
exit 1
