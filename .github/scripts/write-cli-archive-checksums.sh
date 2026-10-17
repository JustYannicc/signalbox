#!/usr/bin/env bash
set -euo pipefail

release_assets_dir="${1:?usage: write-cli-archive-checksums.sh <release-assets-dir>}"
cd "$release_assets_dir"
shopt -s nullglob
archives=(signalbox-*.tar.gz signalbox-*.zip)
if [[ ${#archives[@]} -eq 0 ]]; then
  echo "No CLI archives were produced." >&2
  exit 1
fi

sha256sum "${archives[@]}" > SHA256SUMS
cat SHA256SUMS
