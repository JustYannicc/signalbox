#!/usr/bin/env bash
# Plans a stage and fails unless the plan keeps every resource where it is
# (check-plan.ts). Run from apps/cloud with the stage's env:
#
#   bash infra/plan.sh <stage>
set -euo pipefail

stage="${1:?stage required}"
plan="${RUNNER_TEMP:-/tmp}/alchemy-plan-$stage.txt"
# `--yes` also authorizes state-store upgrades, even with `--dry-run`.
# A plan must stop for an upgrade rather than deploy it as a side effect.
NO_COLOR=1 ./node_modules/.bin/alchemy deploy --stage "$stage" --dry-run --detailed --no-input \
  2>&1 | tee "$plan"
node infra/check-plan.ts "$stage" "$plan"
