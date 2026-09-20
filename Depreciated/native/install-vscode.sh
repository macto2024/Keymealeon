#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target="${VSCODE_EXTENSIONS:-$HOME/.vscode/extensions}/six-local.six-workflow-bridge-0.2.0"
mkdir -p "$target"
cp "$root/vscode-extension/package.json" "$root/vscode-extension/extension.cjs" "$target/"
printf 'Installed SIX VS Code extension in %s\nReload VS Code once to activate it.\n' "$target"
