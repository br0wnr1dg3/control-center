#!/bin/bash
# Build Control Center Board as a macOS .app; `./bundle.sh install` also copies it to /Applications and relaunches.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
APP="build/Control Center Board.app"

swift build -c release

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/ControlCenterBoard "$APP/Contents/MacOS/"
cp Sources/Info.plist "$APP/Contents/Info.plist"
cp Resources/AppIcon.icns "$APP/Contents/Resources/"
codesign --force --sign - "$APP"
echo "Built: $SCRIPT_DIR/$APP"

if [[ "${1:-}" == install ]]; then
  pkill -x ControlCenterBoard || true
  rm -rf "/Applications/Control Center Board.app"
  cp -R "$APP" /Applications/
  open "/Applications/Control Center Board.app"
  echo "Installed and launched."
fi
