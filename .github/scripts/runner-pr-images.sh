#!/usr/bin/env bash
# Pull request Runner images, ghcr.io/justyannicc/signalbox-runner:pr-<number>
# (runner-image.yml publishes one per preview that changes the Runner).
#
#   runner-pr-images.sh delete <number>          deletes that pull request's image
#   runner-pr-images.sh numbers                  lists the pull requests that have one
#   runner-pr-images.sh ids <number>             that pull request's image versions
#   runner-pr-images.sh delete-untagged <id>...  deletes those versions once a push untagged them
#
# Only versions tagged with nothing but pr-<number>, or with nothing at all,
# are deleted, so a digest shared with nightly or a release never goes with
# them. Needs GH_TOKEN with packages: write from this repository's workflows
# (they published the package, so they administer it). RUNNER_IMAGE_VERSIONS,
# when set, is a listing to use instead of asking again (`list`).
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
versions_path='users/JustYannicc/packages/container/signalbox-runner/versions'

# One {"id", "tags"} object per version.
versions() {
  if [[ -n "${RUNNER_IMAGE_VERSIONS:-}" ]]; then
    printf '%s\n' "$RUNNER_IMAGE_VERSIONS"
  else
    gh api --paginate "$versions_path?per_page=100" \
      --jq '.[] | {id, tags: (.metadata.container.tags // [])}'
  fi
}

# The versions tagged with nothing but pr-<number>.
pr_ids() {
  versions | jq -r --arg tag "pr-$1" 'select(.tags == [$tag]) | .id'
}

delete_version() {
  gh api --method DELETE "$versions_path/$1" --silent
}

case "${1:-}" in
  list)
    versions
    ;;
  ids)
    pr_ids "${2:?usage: runner-pr-images.sh ids <number>}"
    ;;
  delete)
    number="${2:?usage: runner-pr-images.sh delete <number>}"
    ids="$(pr_ids "$number")"
    if [[ -z "$ids" ]]; then
      echo "No Runner image for PR #$number to delete."
    fi
    for id in $ids; do
      delete_version "$id"
      echo "Deleted Runner image pr-$number (version $id)."
    done
    ;;
  numbers)
    versions | jq -r '.tags[] | try capture("^pr-(?<number>[1-9][0-9]*)$").number catch empty'
    ;;
  delete-untagged)
    shift
    for id in "$@"; do
      tags="$(gh api "$versions_path/$id" --jq '.metadata.container.tags // [] | length')"
      if [[ "$tags" == "0" ]]; then
        delete_version "$id"
        echo "Deleted replaced Runner image version $id."
      fi
    done
    ;;
  *)
    echo "usage: runner-pr-images.sh list | numbers | ids <number> | delete <number> | delete-untagged <id>..." >&2
    exit 2
    ;;
esac
