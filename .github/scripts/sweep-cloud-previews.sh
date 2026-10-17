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

failed=0
containers="$(apps/cloud/node_modules/.bin/wrangler containers list --json)"
if preview_domain_numbers="$(node .github/scripts/cloudflare-preview-domains.cjs list-prs)"; then
  :
else
  echo "::error::Could not list preview Worker domains."
  preview_domain_numbers=''
  failed=1
fi
# Without production's list, Cloudflare resources still get swept.
if ! assets="$(bash .github/scripts/call-preview-cleanup.sh list)"; then
  echo "::error::Could not list production's preview packs and links."
  assets='{}'
  failed=1
fi
# One "<number> <closed_at> <author>" line per closed pull request.
closed="$(gh api --paginate --jq '.[] | "\(.number) \(.closed_at) \(.user.login)"' \
  'repos/JustYannicc/signalbox/pulls?state=closed&per_page=100')"
closed_numbers="$(cut -d' ' -f1 <<< "$closed")"

# Pull requests with a Runner image left, listed once for every deletion below.
# Without the list, the rest still gets swept.
if RUNNER_IMAGE_VERSIONS="$(bash .github/scripts/runner-pr-images.sh list)"; then
  export RUNNER_IMAGE_VERSIONS
  image_numbers="$(bash .github/scripts/runner-pr-images.sh numbers)"
else
  echo "::error::Could not list pull request Runner images."
  image_numbers=''
  failed=1
fi

candidate_numbers="$(
  sed -nE 's/^signalbox-(cloud|model-gateway)-pr-([1-9][0-9]*)$/\2/p' <<< "$worker_names"
  printf '%s\n' "$preview_domain_numbers"
  printf '%s\n' "$image_numbers"
  jq -r '.[]?.name | try capture("^signalbox-cloud-pr-(?<number>[1-9][0-9]*)-(pools|threads)$").number catch empty' \
    <<< "$containers"
  jq -r '.prNumbers[]?' <<< "$assets"
)"

while IFS= read -r number; do
  [[ -n "$number" ]] || continue
  if grep -Fxq "$number" <<< "$closed_numbers"; then
    if PR_NUMBER="$number" bash .github/scripts/delete-cloud-preview.sh; then
      echo "Cleaned preview resources for closed PR #$number."
    else
      echo "::error::Could not clean preview resources for closed PR #$number."
      failed=1
    fi
  fi
done < <(sort -nu <<< "$candidate_numbers")

# One-off: links made before production's registry existed are only findable by
# asking every production PoolObject. Links expire after 90 days, so only pull
# requests closed within that window can still have them.
if [[ "${BACKFILL_PREVIEW_LINKS:-false}" == "true" ]]; then
  if pool_object_ids="$(bash .github/scripts/list-production-pool-object-ids.sh)"; then
    pool_object_count="$(jq 'length' <<< "$pool_object_ids")"
    cutoff="$(date -u -d '90 days ago' +%Y-%m-%dT%H:%M:%SZ)"
    while read -r number closed_at author; do
      # Only JustYannicc's pull requests get previews.
      [[ -n "$number" && "$closed_at" > "$cutoff" && "$author" == "JustYannicc" ]] || continue
      offset=0
      while ((offset < pool_object_count)); do
        batch="$(jq -c --argjson offset "$offset" '.[$offset : ($offset + 100)]' <<< "$pool_object_ids")"
        if ! bash .github/scripts/call-preview-cleanup.sh delete-links "$number" "$batch"; then
          echo "::error::Could not backfill pool link cleanup for closed PR #$number."
          failed=1
        fi
        offset=$((offset + 100))
      done
    done <<< "$closed"
  else
    echo "::error::Could not list production PoolObjects for the link backfill."
    failed=1
  fi
fi

if [[ "${CLEANUP_LEGACY_PREVIEW_PACKS:-false}" == "true" ]]; then
  if ! bash .github/scripts/call-preview-cleanup.sh clear-legacy-packs; then
    echo "::error::Could not delete legacy preview drive packs."
    failed=1
  fi
fi

exit "$failed"
