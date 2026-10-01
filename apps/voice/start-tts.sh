#!/bin/bash
set -euo pipefail
# Engine query URLs contain text: never export its access log to a logging service.
/opt/voicevox_engine/run --host 127.0.0.1 --disable_mutable_api >/dev/null 2>&1 &
engine_pid=$!
node /app/src/server.js &
api_pid=$!
pids=("$engine_pid" "$api_pid")
# Uvicorn's graceful SIGTERM waits for non-cancellable synthesis. A fixed trial deadline
# or adapter timeout must stop the actual CPU work, not wait for it beyond the budget.
trap 'kill -KILL "${pids[@]}" 2>/dev/null || true; wait || true' EXIT TERM INT
if [ -n "${VOICE_DEADLINE:-}" ]; then
  node /app/src/deadline.js &
  pids+=("$!")
fi
wait -n "${pids[@]}"
# A stopped child must restart the whole container, not leave a false healthy half-service.
exit 1
