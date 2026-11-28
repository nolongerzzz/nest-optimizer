#!/usr/bin/env bash
# Adds "Nest Optimizer" to your applications menu with its icon. Run once, as your normal user (no sudo).
# Works from wherever this folder is; run again after moving it.
# To undo: delete ~/.local/share/applications/nest-optimizer.desktop and the nest-optimizer.png icons.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
[ -x "$HERE/node_modules/.bin/electron" ] || { echo "Run 'npm install' in $HERE first."; exit 1; }
for s in 48 128 256 512; do
  mkdir -p "$DATA/icons/hicolor/${s}x${s}/apps"
  cp "$HERE/assets/icons/icon-$s.png" "$DATA/icons/hicolor/${s}x${s}/apps/nest-optimizer.png"
done
mkdir -p "$DATA/applications"
# --no-sandbox, as the Safex apps start: an npm-installed Electron's sandbox helper is not set up on
# current Ubuntu, and the window only ever loads this folder's own files.
cat > "$DATA/applications/nest-optimizer.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=Nest Optimizer
Comment=3D print prep, slicing and printer control
Exec=sh -c 'cd "$HERE" && exec node_modules/.bin/electron . --no-sandbox'
Path=$HERE
Icon=nest-optimizer
Terminal=false
Categories=Graphics;3DGraphics;
StartupWMClass=nso-desktop
DESK
chmod 644 "$DATA/applications/nest-optimizer.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DATA/applications" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t "$DATA/icons/hicolor" >/dev/null 2>&1 || true
echo "Done. Open 'Nest Optimizer' from your applications menu (you may need to search for it once)."
