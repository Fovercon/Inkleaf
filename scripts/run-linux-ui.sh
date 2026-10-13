#!/bin/bash
# Capture to a regular file so detached desktop services cannot keep tee alive.
# Always report the actual Electron/timeout exit code before accepting proof.
set -euo pipefail
log="${1:?Pass a UI log filename}"
shift
mkdir -p "$(dirname "$log")"
set +e
timeout --kill-after=10s 240s "$@" > "$log" 2>&1
status=$?
set -e
cat "$log"
if [ "$status" -ne 0 ]; then exit "$status"; fi
grep -Fq -- "${INKLEAF_UI_SUCCESS_MARKER:-verify screenshot written}" "$log"
