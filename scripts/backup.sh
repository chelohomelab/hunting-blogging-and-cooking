#!/bin/bash
# Hunting, Blogging and Cooking — backup script
# Run by systemd hbc-backup.timer (daily)
# Can also be run manually: bash /opt/hunting-blogging-and-cooking/scripts/backup.sh

set -euo pipefail
APP_DIR="/opt/hunting-blogging-and-cooking"
cd "$APP_DIR"
source venv/bin/activate 2>/dev/null || true

python3 "$APP_DIR/scripts/backup.py"
