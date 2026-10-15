#!/usr/bin/env bash
# Calls the deployed spike and appends the exchange to evidence/live-run.log.
# Usage: scripts/call.sh METHOD PATH [JSON]
set -euo pipefail
base="${SPIKE_URL:-https://signalbox-spike-349.yannic-bb0.workers.dev}"
log="$(dirname "$0")/../evidence/live-run.log"
method="$1"; path="$2"; body="${3:-}"
if [ -n "$body" ]; then
  out=$(curl -s -X "$method" "$base$path" -H 'content-type: application/json' -d "$body")
else
  out=$(curl -s -X "$method" "$base$path")
fi
{ echo "### $(date -u +%H:%M:%SZ) $method $path ${body}"; echo "$out"; echo; } >> "$log"
echo "$out"
