#!/usr/bin/env bash
# Merges main as it is now into the checkout, without committing, so planning
# production shows what merging the pull request would do to it. Run from the
# repository root with main fetched:
#
#   bash apps/cloud/infra/merge-main.sh origin/main
#
# A pull request's checkout is GitHub's merge of it into its base when the run
# was queued. After a wait in the queue, or for a pull request stacked on
# another branch, that lags main, and production already runs what main added
# since: planning it reads as removing all of that.
#
# Writes `merged=true` to GITHUB_OUTPUT when main brought anything, so the
# caller rebuilds. Fails when main doesn't merge cleanly.
set -euo pipefail

main="${1:?ref to merge required}"
merged=false
if git merge-base --is-ancestor "$main" HEAD; then
  echo "The checkout already has $main."
elif git merge --quiet --no-commit --no-ff "$main"; then
  merged=true
  echo "Merged $main."
else
  git merge --abort
  echo "::error title=Merge main::This doesn't merge cleanly with $main, so there's no telling what merging it would do to production. Merge $main into it."
  exit 1
fi
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "merged=$merged" >> "$GITHUB_OUTPUT"
fi
