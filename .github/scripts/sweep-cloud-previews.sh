#!/usr/bin/env bash
set -euo pipefail

: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

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
closed="$(gh api --paginate --jq '.[].number' \
  'repos/JustYannicc/signalbox/pulls?state=closed&per_page=100')"

candidate_numbers="$(
  sed -nE 's/^signalbox-(cloud|model-gateway)-pr-([1-9][0-9]*)$/\2/p' <<< "$worker_names"
  jq -r '.[]?.name | try capture("^signalbox-cloud-pr-(?<number>[1-9][0-9]*)-(pools|threads)$").number catch empty' \
    <<< "$containers"
  jq -r '.prNumbers[]?' <<< "$assets"
)"

failed=0
while IFS= read -r number; do
  [[ -n "$number" ]] || continue
  if grep -Fxq "$number" <<< "$closed"; then
    if PR_NUMBER="$number" bash .github/scripts/delete-cloud-preview.sh; then
      echo "Cleaned preview resources for closed PR #$number."
    else
      echo "::error::Could not clean preview resources for closed PR #$number."
      failed=1
    fi
  fi
done < <(sort -nu <<< "$candidate_numbers")

if [[ "$failed" == "1" ]]; then exit 1; fi

if [[ "${CLEANUP_LEGACY_PREVIEW_PACKS:-false}" == "true" ]]; then
  bash .github/scripts/call-preview-cleanup.sh clear-legacy-packs
fi
