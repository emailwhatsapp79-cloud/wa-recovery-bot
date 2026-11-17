#!/bin/bash
# Move the WhatsApp login from the old single-user bot into a user of the new app,
# so that user doesn't have to link again.
# Run on the server AFTER that user has signed up:  sudo bash import-old-session.sh you@example.com
set -euo pipefail
EMAIL="${1:?usage: import-old-session.sh <email>}"
HOME_DIR=/var/lib/ocarun
APP=$HOME_DIR/wa-multi
OLD=$HOME_DIR/whatsapp-recovery-bot/auth_info
export PATH=$HOME_DIR/node/bin:$PATH PM2_HOME=$HOME_DIR/.pm2
UID_=$(sudo -u ocarun env PATH="$PATH" node -e "const d=require('$APP/data/db.json');const u=d.users.find(u=>u.email==='$(echo "$EMAIL" | tr A-Z a-z)');if(!u)process.exit(1);console.log(u.id)") \
  || { echo "No user with email $EMAIL"; exit 1; }
[ -f "$OLD/creds.json" ] || { echo "No old login found at $OLD"; exit 1; }
DEST=$APP/data/users/$UID_/auth
rm -rf "$DEST"; mkdir -p "$DEST"; cp -a "$OLD/." "$DEST/"; chown -R ocarun: "$APP/data/users/$UID_"
sudo -u ocarun env PATH="$PATH" PM2_HOME="$PM2_HOME" HOME="$HOME_DIR" pm2 restart wa-multi
echo "Imported. Open the dashboard - it should show Connected in a few seconds."
