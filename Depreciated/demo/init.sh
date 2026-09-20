#!/bin/sh
# The backend only exposes Git keys when the selected folder is a repository ROOT. This folder
# lives inside the Keymaeleon repo, so it needs its own repository to have a diff of its own.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -d "$here/.git" ]; then printf 'Already initialised.\n'; exit 0; fi
git -C "$here" init -q
git -C "$here" add -A
git -C "$here" -c user.name=Keymaeleon -c user.email=demo@localhost commit -qm "Checkout page, before the fix"
printf 'Demo repository ready. Git Diff will now show what Codex changes.\n'
