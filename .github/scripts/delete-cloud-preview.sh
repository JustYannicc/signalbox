#!/usr/bin/env bash
# Deletes one closed pull request's preview. Cloudflare resources go first and
# never wait on production: its cleanup route may be down, not deployed yet, or
# reject the token. Production's part is best effort; any failure exits non-zero
# at the end so the job shows red and the weekly sweep retries.
#
# Needs apps/cloud's dependencies installed: the preview's Alchemy stage is
# destroyed first. The checks after it catch previews wrangler deployed before
# the stack existed, and anything a failed destroy left.
set -euo pipefail

: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
pr_number="${PR_NUMBER:?PR_NUMBER is required}"
failed=0

# The shared preview bucket is retained, so this only drops it from the stage.
# Destroy evaluates the stack, which reads the Worker's config; nothing is
# uploaded, so placeholders do.
if ! (cd apps/cloud && ALCHEMY_TELEMETRY_DISABLED=1 T3CODE_WORKOS_CLIENT_ID=destroy-only \
  SESSION_SECRET=destroy-only T3CODE_WORKOS_API_KEY=destroy-only \
  ./node_modules/.bin/alchemy destroy --stage "pr-$pr_number" --yes --no-input); then
  echo "::error::Could not destroy the Alchemy stage pr-$pr_number."
  failed=1
fi

# Names as apps/cloud/infra/stage.ts gives them to a preview.
wrangler=apps/cloud/node_modules/.bin/wrangler
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

containers="$("$wrangler" containers list --json)"

for name in "signalbox-model-gateway-pr-$pr_number" "signalbox-cloud-pr-$pr_number"; do
  if ! grep -Fxq "$name" <<< "$worker_names"; then
    echo "No preview Worker $name to delete."
  elif ! "$wrangler" delete --name "$name" --force; then
    echo "::error::Could not delete preview Worker $name."
    failed=1
  fi
done

for app in pools threads; do
  id="$(jq -r --arg name "signalbox-cloud-pr-$pr_number-$app" \
    '.[] | select(.name == $name) | .id' <<< "$containers")"
  if [[ -z "$id" ]]; then
    echo "No preview container signalbox-cloud-pr-$pr_number-$app to delete."
  elif ! "$wrangler" containers delete "$id"; then
    echo "::error::Could not delete preview container signalbox-cloud-pr-$pr_number-$app."
    failed=1
  fi
done

# Production drops the preview's pool links (from its registry) and R2 prefix.
if ! bash .github/scripts/call-preview-cleanup.sh delete "$pr_number"; then
  echo "::error::Production could not clean up PR #$pr_number's drive packs and pool links."
  failed=1
fi

exit "$failed"
