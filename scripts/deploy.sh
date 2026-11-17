#!/bin/bash
# Install / update the multi-user app on the Oracle server.
# Run on the server:  sudo bash deploy.sh /tmp/wa-multi.tar.gz
# - Installs into /var/lib/ocarun/wa-multi (owned by the same user the old bot runs as)
# - Stops the old single-user bot (its folder is left untouched, so you can roll back)
# - Starts the new app on port 8080 under pm2, so the Vercel link keeps working
set -euo pipefail
TARBALL="${1:-/tmp/wa-multi.tar.gz}"
RUN_AS=ocarun
HOME_DIR=/var/lib/ocarun
APP=$HOME_DIR/wa-multi
NODE_BIN=$HOME_DIR/node/bin
export PATH=$NODE_BIN:$PATH
export PM2_HOME=$HOME_DIR/.pm2
PM2="$NODE_BIN/pm2"; [ -x "$PM2" ] || PM2=$(command -v pm2 || true)

echo "== unpacking to $APP (data/ is kept on updates)"
mkdir -p "$APP"
tar -xzf "$TARBALL" -C "$APP" --exclude='data'
chown -R $RUN_AS: "$APP"

echo "== installing packages"
sudo -u $RUN_AS env PATH="$PATH" HOME="$HOME_DIR" bash -c "cd '$APP' && npm install --omit=dev --no-audit --no-fund"
sudo -u $RUN_AS env PATH="$PATH" bash -c "cd '$APP' && node --check server.js"

if [ -z "$PM2" ]; then echo "pm2 not found under $NODE_BIN"; exit 1; fi
run_pm2() { sudo -u $RUN_AS env PATH="$PATH" PM2_HOME="$PM2_HOME" HOME="$HOME_DIR" "$PM2" "$@"; }

echo "== stopping old single-user bot (folder kept for rollback)"
run_pm2 stop wa-bot >/dev/null 2>&1 || true
run_pm2 delete wa-bot >/dev/null 2>&1 || true

echo "== starting new app"
run_pm2 delete wa-multi >/dev/null 2>&1 || true
run_pm2 start "$APP/server.js" --name wa-multi --cwd "$APP" --max-memory-restart 6G --time
run_pm2 save
sleep 4
echo "== status"
run_pm2 ls
ss -tlnp | grep 8080 || echo "!! nothing listening on 8080 yet - check: pm2 logs wa-multi"
if [ -f "$APP/data/ADMIN_INVITE.txt" ]; then
  echo; echo "== FIRST ADMIN INVITE CODE: $(cat "$APP/data/ADMIN_INVITE.txt")"
  echo "   Open the site, go to Sign up, use this code."
fi
