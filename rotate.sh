#!/usr/bin/env bash
# Moves the staff page to a new random folder (new link). Run from the repo root, then commit and push.
set -euo pipefail
OLD=$(for d in */; do [ -f "$d/index.html" ] && echo "${d%/}"; done)
[ "$(echo "$OLD" | wc -l)" = 1 ] || { echo "expected exactly one page folder, found: $OLD" >&2; exit 1; }
NEW=$(python3 -c "import secrets,string;a=string.ascii_lowercase+string.digits;print(''.join(secrets.choice(a) for _ in range(10)))")
git mv "$OLD" "$NEW"
echo "$NEW"
