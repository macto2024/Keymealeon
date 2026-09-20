#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# Read the directory identity from the manifest so updates cannot drift from it.
identity=$(python3 - "$root/vscode-extension/package.json" <<'PY'
import json, re, sys
m = json.load(open(sys.argv[1]))
identity = f"{m['publisher']}.{m['name']}-{m['version']}"
if not re.fullmatch(r'[A-Za-z0-9._-]+', identity):
    raise SystemExit('Invalid extension identity')
print(identity)
PY
)
target="${VSCODE_EXTENSIONS:-$HOME/.vscode/extensions}/$identity"
mkdir -p "$target"
for source in workflow.cjs extension.cjs; do
  cp "$root/vscode-extension/$source" "$target/$source.new"
  mv "$target/$source.new" "$target/$source"
done
cp "$root/vscode-extension/package.json" "$target/package.json.new"
mv "$target/package.json.new" "$target/package.json"
printf 'Installed Keymaeleon VS Code bridge in %s\nReload VS Code once, then start companion/keymaeleon_6.py.\n' "$target"
