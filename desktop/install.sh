#!/usr/bin/env bash
# Nest Optimizer desktop: installer for Mac and Linux.
# Run it from this folder:   bash install.sh
# Checks Node.js, installs the app's parts, and adds a clickable launcher
# (Mac: "Nest Optimizer" in ~/Applications; Linux: a menu entry). Safe to run again.
set -euo pipefail
cd "$(dirname "$0")"
OS="$(uname -s)"
say() { printf '\n== %s\n' "$*"; }

say "Checking Node.js (version 18 or newer)"
need_node=1
if command -v node >/dev/null 2>&1; then
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] && need_node=0
fi
if [ "$need_node" = 1 ]; then
  if [ "$OS" = "Linux" ] && command -v apt-get >/dev/null 2>&1; then
    echo "Node.js is missing or too old. Installing Node.js 20 (asks for your password once)."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif [ "$OS" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    brew install node
  else
    echo "Node.js 18 or newer is needed. Install it from https://nodejs.org (the LTS button), then run this again."
    exit 1
  fi
fi
echo "Node.js $(node -v) is ready."

say "Checking git (the app updates itself with it)"
if ! command -v git >/dev/null 2>&1; then echo "git is not installed. Install it, then run this again."; exit 1; fi
if git -C .. rev-parse --abbrev-ref HEAD >/dev/null 2>&1; then
  echo "This copy follows the branch: $(git -C .. rev-parse --abbrev-ref HEAD)"
else
  echo "This folder is not a git checkout, so the app will run but cannot update itself."
fi

say "Installing the app's parts (first time: a minute or two, needs internet)"
npm install --no-audit --no-fund

launcher=""
if [ "$OS" = "Darwin" ]; then
  xattr -dr com.apple.quarantine . 2>/dev/null || true
  say "Launcher"
  bash tools/install-mac-launcher.sh && launcher="mac"
elif [ "$OS" = "Linux" ]; then
  say "Menu entry"
  bash tools/install-menu-entry.sh && launcher="linux"
fi

say "Done"
[ "$launcher" = "mac" ] && echo "Open 'Nest Optimizer' from ~/Applications (Finder > Go > Home > Applications), Launchpad or Spotlight. Drag it to the Dock to keep it there."
[ "$launcher" = "linux" ] && echo "Open 'Nest Optimizer' from your applications menu."
echo "Or start it from here with:  npm start"
