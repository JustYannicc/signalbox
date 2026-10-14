#!/usr/bin/env bash
set -euo pipefail

action="${1:?action required}"
number="${2:-}"
pool_object_ids="${3:-}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cleanup_token="$(bash "$script_dir/preview-cleanup-token.sh")"
body="$(jq -cn --arg action "$action" '{action: $action}')"
if [[ -n "$pool_object_ids" ]]; then
  body="$(jq -cn --arg action "$action" --argjson number "$number" \
    --argjson poolObjectIds "$pool_object_ids" \
    '{action: $action, pullRequestNumber: $number, poolObjectIds: $poolObjectIds}')"
elif [[ -n "$number" ]]; then
  body="$(jq -cn --arg action "$action" --argjson number "$number" \
    '{action: $action, pullRequestNumber: $number}')"
fi

curl --fail --silent --show-error --retry 5 --retry-all-errors --retry-delay 5 \
  --request POST https://app.signalbox.run/api/internal/preview-cleanup \
  --header "Authorization: Bearer $cleanup_token" \
  --header 'Content-Type: application/json' \
  --data "$body"
