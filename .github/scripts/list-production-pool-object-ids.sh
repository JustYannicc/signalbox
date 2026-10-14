#!/usr/bin/env bash
set -euo pipefail

: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"

namespaces="$(curl --fail --silent --show-error --get \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --data-urlencode 'per_page=1000' \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/durable_objects/namespaces")"
namespace_ids="$(jq -r \
  '.result[]? | select(.script == "signalbox-cloud" and .class == "PoolObject") | .id | select(type == "string")' \
  <<< "$namespaces")"
namespace_count="$(grep -c . <<< "$namespace_ids" || true)"
if [[ "$namespace_count" != "1" ]]; then
  echo "Expected one production PoolObject namespace, found $namespace_count." >&2
  exit 1
fi
namespace_id="$namespace_ids"

object_ids='[]'
cursor=''
while true; do
  query_args=(--data-urlencode 'limit=10000')
  if [[ -n "$cursor" ]]; then query_args+=(--data-urlencode "cursor=$cursor"); fi
  response="$(curl --fail --silent --show-error --get \
    --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "${query_args[@]}" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/durable_objects/namespaces/$namespace_id/objects")"
  page_ids="$(jq -c '[.result[]? | select(.hasStoredData != false) | .id | select(type == "string")]' <<< "$response")"
  object_ids="$(jq -cn --argjson existing "$object_ids" --argjson page "$page_ids" '$existing + $page')"
  next_cursor="$(jq -r '.result_info.cursor // empty' <<< "$response")"
  if [[ -z "$next_cursor" ]]; then break; fi
  if [[ "$next_cursor" == "$cursor" ]]; then
    echo "Cloudflare repeated the Durable Object listing cursor." >&2
    exit 1
  fi
  cursor="$next_cursor"
done

jq -c 'unique' <<< "$object_ids"
