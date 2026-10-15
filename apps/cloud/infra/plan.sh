#!/usr/bin/env bash
# Plans a stage and fails unless the plan keeps every resource where it is
# (check-plan.ts). Run from apps/cloud with the stage's env:
#
#   bash infra/plan.sh <stage>
set -euo pipefail

stage="${1:?stage required}"
plan="${RUNNER_TEMP:-/tmp}/alchemy-plan-$stage.txt"
# TEMPORARY (#298 token diagnosis): with DISTILLED_DEBUG_HTTP set, distilled
# prints each request's method and path template, and each response. Keep
# only requests and error responses: successful bodies never reach the log.
NO_COLOR=1 ./node_modules/.bin/alchemy deploy --stage "$stage" --dry-run --detailed --yes --no-input \
  2>&1 | grep --line-buffered -v -E '^\[distilled\] <- [23][0-9]{2} ' | tee "$plan"
node infra/check-plan.ts "$stage" "$plan"
