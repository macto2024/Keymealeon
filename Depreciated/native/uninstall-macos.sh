#!/bin/sh
set -eu
agent="$HOME/Library/LaunchAgents/com.six.keyboard.plist"
launchctl bootout "gui/$(id -u)/com.six.keyboard" 2>/dev/null || true
if [ -f "$agent" ]; then mv "$agent" "$agent.disabled"; fi
printf 'SIX login launch disabled. The project files remain in place.\n'
