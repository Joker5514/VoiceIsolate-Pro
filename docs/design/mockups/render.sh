#!/usr/bin/env sh
# Render the mockups to PNG with Chromium's headless shell.
# Usage: ./render.sh [scale]   (default 2 -> 3840x2400)
set -e
cd "$(dirname "$0")"
SCALE="${1:-2}"
BIN="${VIP_HEADLESS_SHELL:-$(ls /opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell 2>/dev/null | head -1)}"
mkdir -p png
for page in explain stems engineer; do
  "$BIN" --no-sandbox --hide-scrollbars --disable-gpu --allow-file-access-from-files \
    --window-size=1920,1200 --force-device-scale-factor="$SCALE" --virtual-time-budget=20000 \
    --screenshot="png/$page.png" "file://$PWD/$page.html" >/dev/null 2>&1
  echo "png/$page.png"
done
