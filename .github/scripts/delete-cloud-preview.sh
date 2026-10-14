#!/usr/bin/env bash
set -euo pipefail

: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
pr_number="${PR_NUMBER:?PR_NUMBER is required}"
worker_names=''
page=1
while true; do
  result="$(curl --fail --silent --show-error --get \
    --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    --data-urlencode 'per_page=1000' \
    --data-urlencode "page=$page" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts")"
  worker_names+="$(jq -r '.result[]?.id' <<< "$result")"$'\n'
  total_pages="$(jq -r '.result_info.total_pages // 1' <<< "$result")"
  ((page >= total_pages)) && break
  ((page += 1))
done

containers="$(npx --yes wrangler@4 containers list --json)"
assets="$(bash .github/scripts/call-preview-cleanup.sh list)"
has_preview_assets=false
for name in "signalbox-model-gateway-pr-$pr_number" "signalbox-cloud-pr-$pr_number"; do
  if grep -Fxq "$name" <<< "$worker_names"; then has_preview_assets=true; fi
done
for app in pools threads; do
  id="$(jq -r --arg name "signalbox-cloud-pr-$pr_number-$app" \
    '.[] | select(.name == $name) | .id' <<< "$containers")"
  if [[ -n "$id" ]]; then has_preview_assets=true; fi
done
if jq -e --argjson number "$pr_number" '.prNumbers | index($number) != null' \
  <<< "$assets" >/dev/null; then
  has_preview_assets=true
fi
if [[ "$has_preview_assets" != "true" ]]; then
  echo "No Cloudflare preview resources found for PR #$pr_number."
  exit 0
fi

pool_object_ids="$(bash .github/scripts/list-production-pool-object-ids.sh)"
pool_object_count="$(jq 'length' <<< "$pool_object_ids")"
offset=0
while ((offset < pool_object_count)); do
  pool_object_batch="$(jq -c --argjson offset "$offset" '.[$offset : ($offset + 100)]' <<< "$pool_object_ids")"
  bash .github/scripts/call-preview-cleanup.sh delete-links "$pr_number" "$pool_object_batch"
  offset=$((offset + 100))
done

for name in "signalbox-model-gateway-pr-$pr_number" "signalbox-cloud-pr-$pr_number"; do
  if grep -Fxq "$name" <<< "$worker_names"; then
    npx --yes wrangler@4 delete --name "$name" --force
  else
    echo "No preview Worker $name to delete."
  fi
done

for app in pools threads; do
  id="$(jq -r --arg name "signalbox-cloud-pr-$pr_number-$app" \
    '.[] | select(.name == $name) | .id' <<< "$containers")"
  if [[ -n "$id" ]]; then
    npx --yes wrangler@4 containers delete "$id"
  else
    echo "No preview container signalbox-cloud-pr-$pr_number-$app to delete."
  fi
done

bash .github/scripts/call-preview-cleanup.sh delete "$pr_number"
