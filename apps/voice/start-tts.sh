#!/bin/bash
set -euo pipefail
# Engine query URLs contain text: never export its access log to a logging service.
/opt/voicevox_engine/run --host 127.0.0.1 --disable_mutable_api >/dev/null 2>&1 &
engine_pid=$!
node /app/src/server.js &
api_pid=$!
trap 'kill "$engine_pid" "$api_pid" 2>/dev/null || true; wait || true' EXIT TERM INT
wait -n "$engine_pid" "$api_pid"
# A stopped child must restart the whole container, not leave a false healthy half-service.
exit 1
