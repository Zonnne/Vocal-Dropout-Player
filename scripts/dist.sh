#!/bin/bash
# ============================================================
# Vocal Dropout Player — distribution builder
#
# Builds every shippable artifact into dist/:
#   macOS Apple Silicon  -> Vocal Dropout Player-<v>-arm64.dmg
#   macOS Intel          -> Vocal Dropout Player-<v>.dmg
#   Windows installer    -> Vocal Dropout Player Setup <v>.exe  (NSIS)
#   Windows portable     -> Vocal Dropout Player-<v>-win.zip
#
# Usage:
#   ./scripts/dist.sh            # build everything
#   ./scripts/dist.sh mac        # arm64 + intel dmg only
#   ./scripts/dist.sh win        # windows nsis + zip only
#   ./scripts/dist.sh arm64      # apple silicon dmg only
#   ./scripts/dist.sh intel      # intel dmg only
#
# Signing / notarization (optional, for warning-free installs):
#   export CSC_NAME="Developer ID Application: Your Name (TEAMID)"
#   export APPLE_ID="you@example.com"
#   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
#   export APPLE_TEAM_ID="ABCDE12345"
# …then run this script — electron-builder picks them up automatically.
# ============================================================
set -e
cd "$(dirname "$0")/.."

TARGET="${1:-all}"

if [ ! -d node_modules/electron ]; then
  echo ">> installing dependencies…"
  npm install
fi

# electron's postinstall is often blocked by npm allow-scripts and leaves a
# half-extracted binary — verify and repair before building
ELECTRON_BIN="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ -d node_modules/electron ] && ! "$ELECTRON_BIN" --version > /dev/null 2>&1; then
  echo ">> repairing electron binary (half-extracted dist)…"
  ZIP=$(find ~/Library/Caches/electron -name "electron-v*-darwin-arm64.zip" | head -1)
  if [ -n "$ZIP" ]; then
    rm -rf node_modules/electron/dist
    mkdir -p node_modules/electron/dist
    ditto -x -k "$ZIP" node_modules/electron/dist
    printf "Electron.app/Contents/MacOS/Electron" > node_modules/electron/path.txt
  else
    rm -rf node_modules/electron/dist node_modules/electron/path.txt
    node node_modules/electron/install.js
  fi
fi

case "$TARGET" in
  all)    npm run dist:all ;;
  mac)    npx electron-builder --mac --arm64 --x64 ;;
  arm64)  npm run dist ;;
  intel)  npm run dist:intel ;;
  win)    npm run dist:win ;;
  *) echo "unknown target: $TARGET (use: all | mac | arm64 | intel | win)"; exit 1 ;;
esac

echo ""
echo ">> artifacts in dist/:"
for f in dist/*.dmg dist/*.exe dist/*-win.zip; do
  [ -e "$f" ] && printf "   %5.0fMB  %s\n" "$(echo "$(stat -f%z "$f")/1048576" | bc)" "$f"
done
