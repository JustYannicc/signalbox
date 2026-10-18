#!/usr/bin/env bash
# Plans a stage and fails unless the plan keeps every resource where it is
# (check-plan.ts). Run from apps/cloud with the stage's env:
#
#   bash infra/plan.sh <stage>
set -euo pipefail

stage="${1:?stage required}"
plan="${RUNNER_TEMP:-/tmp}/alchemy-plan-$stage.txt"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NO_COLOR=1 ./node_modules/.bin/alchemy deploy --stage "$stage" --dry-run --detailed --yes --no-input \
  2>&1 | tee "$plan"
# The trusted wrapper can run against a PR's apps/cloud. Keep its checker from
# the same checkout as this wrapper while Alchemy still loads that PR's stack.
node "$script_dir/check-plan.ts" "$stage" "$plan"
