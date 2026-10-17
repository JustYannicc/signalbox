#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: apply-carry-patches.sh <CLIProxyAPI source directory> [--check]" >&2
  exit 2
fi

source_dir=$1
mode=${2:-apply}
case "$mode" in
  apply|--check) ;;
  *) echo "unknown mode: $mode" >&2; exit 2 ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
version=$(git -C "$source_dir" describe --tags --exact-match 2>/dev/null || echo unknown)

if [ "$mode" = "--check" ]; then
  index_file=$(mktemp)
  rm -f "$index_file"
  trap 'rm -f "$index_file"' EXIT HUP INT TERM
  GIT_INDEX_FILE=$index_file git -C "$source_dir" read-tree HEAD
fi

found_patch=false
for patch_file in "$script_dir"/cliproxyapi-*.patch; do
  [ -f "$patch_file" ] || continue
  found_patch=true
  patch_name=$(basename "$patch_file")
  if [ "$mode" = "--check" ]; then
    if ! GIT_INDEX_FILE=$index_file git -C "$source_dir" apply --cached --check "$patch_file"; then
      echo "CLIProxyAPI carry patch $patch_name no longer applies to $version; review whether upstream has included it, then update or remove the carry patch." >&2
      exit 1
    fi
    GIT_INDEX_FILE=$index_file git -C "$source_dir" apply --cached "$patch_file"
  else
    if ! git -C "$source_dir" apply --check "$patch_file"; then
      echo "CLIProxyAPI carry patch $patch_name no longer applies to $version; review whether upstream has included it, then update or remove the carry patch." >&2
      exit 1
    fi
    git -C "$source_dir" apply "$patch_file"
  fi
done

if [ "$found_patch" = false ]; then
  echo "No CLIProxyAPI carry patches are present." >&2
  exit 1
fi
