#!/usr/bin/env bash
set -euo pipefail

manifest=apps/cloud/containers/cliproxyapi/release.json
branch=automation/cliproxyapi-update
git fetch origin +refs/heads/main:refs/remotes/origin/main
base_sha="$(git rev-parse origin/main)"
git show "$base_sha:$manifest" > "$RUNNER_TEMP/cliproxyapi-current.json"
version="$(jq -er '.version' "$RUNNER_TEMP/cliproxyapi-current.json")"
policy="$(python3 -m scripts.cliproxyapi.release_policy "$RUNNER_TEMP/cliproxyapi-current.json" "$version")"
if [[ "$(jq -r '.held' <<< "$policy")" != "true" ]]; then
  echo "rollback=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

branch_sha=""
if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  git fetch origin "+refs/heads/$branch:refs/remotes/origin/$branch"
  branch_sha="$(git rev-parse "origin/$branch")"
  branch_base="$(git merge-base "$base_sha" "$branch_sha")"
  changed="$(git diff --name-only "$branch_base" "$branch_sha")"
  if [[ -n "$changed" && "$changed" != "$manifest" ]]; then
    echo "The release branch contains unrelated changes; preserving it." >&2
    exit 1
  fi
  git show "$branch_sha:$manifest" > "$RUNNER_TEMP/cliproxyapi-branch.json"
  branch_holds="$(jq -cS '.holds // []' "$RUNNER_TEMP/cliproxyapi-branch.json")"
  base_holds="$(git show "$branch_base:$manifest" | jq -cS '.holds // []')"
  current_holds="$(jq -cS '.holds // []' "$RUNNER_TEMP/cliproxyapi-current.json")"
  if [[ "$branch_holds" != "$base_holds" && "$branch_holds" != "$current_holds" ]]; then
    echo "The release branch contains unmerged hold changes; preserving it." >&2
    exit 1
  fi
fi

pr="$(gh pr list --state open --head "$branch" --json number,baseRefName,labels)"
if ! jq -e 'all(.[]; .baseRefName == "main" and any(.labels[]; .name == "cli-proxyapi-update"))' <<< "$pr" >/dev/null; then
  echo "The open release PR is not owned by release sync; preserving it." >&2
  exit 1
fi

git checkout -B "$branch" "$base_sha"
result="$(python3 -m scripts.cliproxyapi.rollback "$manifest" --held --pr-body "$RUNNER_TEMP/cliproxyapi-pr-body.md")"
push=true
if [[ -n "$branch_sha" ]] && [[ "$(jq -cS . "$RUNNER_TEMP/cliproxyapi-branch.json")" == "$(jq -cS . "$manifest")" ]]; then
  push=false
fi
if [[ "$push" == "true" ]]; then
  number="$(jq -r '.[0].number // empty' <<< "$pr")"
  if [[ -n "$number" ]]; then
    auto_merge="$(gh pr view "$number" --json autoMergeRequest --jq '.autoMergeRequest != null')"
    if [[ "$auto_merge" == "true" ]]; then gh pr merge "$number" --disable-auto; fi
  fi
fi

{
  echo "rollback=true"
  echo "push=$push"
  echo "branch=$branch"
  echo "base_sha=$base_sha"
  echo "branch_sha=$branch_sha"
  jq -r '"version=\(.version)\nprevious=\(.previous)"' <<< "$result"
} >> "$GITHUB_OUTPUT"
echo "The pinned CLIProxyAPI $version is held. An evidenced rollback will use the release PR gates." >> "$GITHUB_STEP_SUMMARY"
