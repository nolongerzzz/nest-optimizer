#!/usr/bin/env bash
# Adds "Nest Optimizer.app" to ~/Applications: a small launcher that starts the app from THIS folder.
# The app itself stays here (so it can update itself with git); the launcher only points at it.
# Run again after moving this folder. To undo: delete ~/Applications/Nest Optimizer.app.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ELECTRON="$HERE/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
[ -x "$ELECTRON" ] || { echo "Run 'npm install' in $HERE first."; exit 1; }
APP="$HOME/Applications/Nest Optimizer.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# The icon: an .icns made from assets/icon.png with the tools every Mac has.
if command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  SET="$(mktemp -d)/nso.iconset"; mkdir -p "$SET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$HERE/assets/icon.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
    d=$((s * 2)); sips -z $d $d "$HERE/assets/icon.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$SET" -o "$APP/Contents/Resources/nso.icns" 2>/dev/null || true
fi

cat > "$APP/Contents/MacOS/nso" <<RUN
#!/bin/sh
# Starts Nest Optimizer from its folder. Made by tools/install-mac-launcher.sh.
HERE="$HERE"
if [ ! -x "\$HERE/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ]; then
  osascript -e 'display dialog "Nest Optimizer was moved or is not installed. Run: bash install.sh in its desktop folder." buttons {"OK"} default button 1 with icon caution' >/dev/null 2>&1
  exit 1
fi
exec "\$HERE/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" "\$HERE"
RUN
chmod +x "$APP/Contents/MacOS/nso"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Nest Optimizer</string>
  <key>CFBundleDisplayName</key><string>Nest Optimizer</string>
  <key>CFBundleIdentifier</key><string>com.nolongerzzz.nso.launcher</string>
  <key>CFBundleExecutable</key><string>nso</string>
  <key>CFBundleIconFile</key><string>nso</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>10.15</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
touch "$APP"
echo "Made: $APP"
