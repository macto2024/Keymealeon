#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
node=$(command -v node)
ffmpeg=$(command -v ffmpeg || true)
whisper=$(command -v whisper || true)
"$root/native/build-macos.sh"
runtime="$HOME/Library/Application Support/SIX"
mkdir -p "$runtime/server"
launchctl bootout "gui/$(id -u)/com.six.keyboard" 2>/dev/null || true
rm -rf "$runtime/SixHost.app"
cp -R "$root/native/bin/SixHost.app" "$runtime/SixHost.app"
cp "$root/server/"*.js "$runtime/server/"
cp "$root/live.js" "$root/six.config.json" "$runtime/"
# A display client (index.html, style.css, app.js) is not part of this backend repository. Copy one
# into "$runtime" if you want the native monitor WebView to render keys rather than a 404.
agent="$HOME/Library/LaunchAgents/com.six.keyboard.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/SIX"
python3 - "$agent" "$runtime/SixHost.app/Contents/MacOS/SixHost" "$node" "$runtime" "$HOME/Library/Logs/SIX" "$ffmpeg" "$whisper" "$PATH" <<'PY'
import plistlib, sys
agent, host, node, root, logs, ffmpeg, whisper, path = sys.argv[1:]
with open(agent, 'wb') as file:
    plistlib.dump({
        'Label': 'com.six.keyboard', 'ProgramArguments': [host, '--node', node, '--root', root],
        'WorkingDirectory': root, 'RunAtLoad': True, 'KeepAlive': False,
        'LimitLoadToSessionType': 'Aqua',
        'EnvironmentVariables': {'SIX_FFMPEG': ffmpeg, 'SIX_WHISPER': whisper, 'PATH': path},
        'StandardOutPath': logs + '/host.log', 'StandardErrorPath': logs + '/host-error.log',
    }, file)
PY
if ! launchctl bootstrap "gui/$(id -u)" "$agent" 2>/dev/null; then
  sleep 1
  launchctl bootstrap "gui/$(id -u)" "$agent"
fi
printf 'SIX monitor installed for login. Manage it in System Settings → Login Items.\n'
