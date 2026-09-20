#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
bundle="$root/native/bin/SixHost.app"
mkdir -p "$bundle/Contents/MacOS" /private/tmp/six-clang-cache
cat > "$bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>SIX</string>
  <key>CFBundleDisplayName</key><string>SIX</string>
  <key>CFBundleIdentifier</key><string>dev.six.keyboard</string>
  <key>CFBundleExecutable</key><string>SixHost</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.3.0</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Record a spoken request when you press Talk to Codex.</string>
</dict></plist>
PLIST
xcrun clang -fobjc-arc -fmodules-cache-path=/private/tmp/six-clang-cache -framework Cocoa -framework WebKit "$root/native/SixHost.m" -o "$bundle/Contents/MacOS/SixHost"
codesign --force --sign - "$bundle"
printf 'Built %s\n' "$bundle"
