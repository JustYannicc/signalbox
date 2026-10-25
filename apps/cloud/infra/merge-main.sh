#!/usr/bin/env bash
# Merges main as it is now into the checkout, without committing, so planning
# production shows what merging the pull request would do to it. Run from the
# repository root with main fetched:
#
#   bash apps/cloud/infra/merge-main.sh origin/main
#
# The preview first merges the pinned PR head and base, without depending on
# GitHub's replaceable merge ref. After a wait in the queue, or for a pull
# request stacked on another branch, that can lag main. Production already
# runs what main added since: planning it reads as removing all of that.
#
# Writes `merged=true` to GITHUB_OUTPUT when main brought anything, so the
# caller rebuilds. Fails when main doesn't merge cleanly.
set -euo pipefail

main="${1:?ref to merge required}"
merged=false
if git merge-base --is-ancestor "$main" HEAD; then
  echo "The checkout already has $main."
# Nothing is committed, but git wants an identity for any merge and CI has none.
elif git -c user.name=ci -c user.email=ci@localhost merge --quiet --no-commit --no-ff "$main"; then
  merged=true
  echo "Merged $main."
elif git rev-parse --quiet --verify MERGE_HEAD > /dev/null; then
  git merge --abort
  echo "::error title=Merge main::This doesn't merge cleanly with $main, so there's no telling what merging it would do to production. Merge $main into it."
  exit 1
else
  echo "::error title=Merge main::Couldn't merge $main (see git's error above)."
  exit 1
fi
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "merged=$merged" >> "$GITHUB_OUTPUT"
fi
