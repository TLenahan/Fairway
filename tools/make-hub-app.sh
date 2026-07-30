#!/bin/bash
# Build FairwayHub.app — a minimal macOS bundle wrapping the hub's Node entry.
# Needed because bare `node` gets SIGABRT-killed by TCC on first CoreBluetooth
# access (no NSBluetoothAlwaysUsageDescription in its Info.plist). The bundle
# supplies the usage description; macOS prompts once for Bluetooth on first run.
# Output: apps/hub/dist-app/FairwayHub.app  (logs to ~/.fairway/hub.log)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
APP="$REPO/apps/hub/dist-app/FairwayHub.app"

mkdir -p "$APP/Contents/MacOS"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>hub</string>
  <key>CFBundleIdentifier</key><string>com.fairway.hub</string>
  <key>CFBundleName</key><string>FairwayHub</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSBluetoothAlwaysUsageDescription</key><string>Streams wrist angles from the HackMotion sensor during practice sessions.</string>
  <key>NSLocalNetworkUsageDescription</key><string>Talks to the Uneekor EYE MINI launch monitor on your Wi-Fi.</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST

cat > "$APP/Contents/MacOS/hub" <<SH
#!/bin/bash
mkdir -p "\$HOME/.fairway"
cd "$REPO"
exec "$NODE_BIN" -r @swc-node/register apps/hub/src/main.ts >> "\$HOME/.fairway/hub.log" 2>&1
SH
chmod +x "$APP/Contents/MacOS/hub"
codesign --force -s - "$APP"
echo "built $APP"
echo "run:  yarn nx run hub:build-ui && open '$APP'   (UI: http://localhost:4271, log: ~/.fairway/hub.log)"
