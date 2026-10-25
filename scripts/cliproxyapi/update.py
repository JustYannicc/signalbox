"""Update the shared CLIProxyAPI release manifest from a verified release."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from .release_policy import fail, matching_holds, read_json, semver

PLATFORMS = {
    "darwin-arm64": "darwin_aarch64",
    "darwin-x64": "darwin_amd64",
    "linux-arm64": "linux_aarch64",
    "linux-x64": "linux_amd64",
    "win32-arm64": "windows_aarch64",
    "win32-x64": "windows_amd64",
}
CONTAINER_ARCHIVE = "CLIProxyAPI_{version}_linux_amd64_no-plugin.tar.gz"


def read_checksums(path: Path) -> dict[str, str]:
    checksums: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        fields = line.split()
        if len(fields) < 2:
            continue
        filename = fields[-1].lstrip("*").rsplit("/", 1)[-1]
        checksum = fields[0].lower()
        previous = checksums.get(filename)
        if previous and previous != checksum:
            fail(f"checksums.txt has conflicting SHA-256 entries for {filename}.")
        checksums[filename] = checksum
    return checksums


def main() -> None:
    if len(sys.argv) != 5:
        fail(
            "usage: python3 -m scripts.cliproxyapi.update release.json checksums.txt source-commit shared-release.json"
        )

    release_path, checksums_path = map(Path, sys.argv[1:3])
    source_commit = sys.argv[3].lower()
    manifest_path = Path(sys.argv[4])
    if not re.fullmatch(r"[a-f0-9]{40}", source_commit):
        fail(f"Expected a full upstream source commit hash, got {source_commit!r}.")
    release = read_json(release_path)
    tag = release.get("tag_name", "")
    match = re.fullmatch(r"v(\d+\.\d+\.\d+)", tag)
    if not match or release.get("draft") or release.get("prerelease"):
        fail(f"Expected a stable vX.Y.Z release, got {tag!r}.")
    version = match.group(1)

    manifest = read_json(manifest_path)
    previous = manifest.get("version")
    if semver(version) <= semver(previous):
        fail(f"Upstream release {version} is not newer than the pinned {previous}.")
    if matching_holds(version, manifest):
        fail(f"CLIProxyAPI release {version} is held; see the manifest's holds.")

    release_assets: dict[str, dict[str, Any]] = {}
    for asset in release.get("assets", []):
        if isinstance(asset, dict) and isinstance(asset.get("name"), str):
            release_assets[asset["name"]] = asset
    checksums = read_checksums(checksums_path)

    def asset(name: str) -> dict[str, Any]:
        metadata = release_assets.get(name)
        checksum = checksums.get(name)
        if metadata is None:
            fail(f"Release is missing the required asset: {name}")
        if checksum is None or not re.fullmatch(r"[a-f0-9]{64}", checksum):
            fail(f"Release is missing a valid SHA-256 in checksums.txt: {name}")
        size = metadata.get("size")
        if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
            fail(f"Release has no valid size for {name}.")
        return {"name": name, "bytes": size, "sha256": checksum}

    platforms = {
        platform: asset(
            f"CLIProxyAPI_{version}_{arch}."
            f"{'zip' if platform.startswith('win32-') else 'tar.gz'}"
        )
        for platform, arch in PLATFORMS.items()
    }
    container = asset(CONTAINER_ARCHIVE.format(version=version))
    updated = {
        "version": version,
        "source": {"commit": source_commit},
        "platforms": platforms,
        "container": container,
    }
    if "holds" in manifest:
        updated["holds"] = manifest["holds"]
    manifest_path.write_text(f"{json.dumps(updated, indent=2)}\n", encoding="utf-8")

    output = f"version={version}\nsource_commit={source_commit}\nprevious_version={previous}\n"
    output_path = os.environ.get("GITHUB_OUTPUT")
    if output_path:
        with open(output_path, "a", encoding="utf-8") as output_file:
            output_file.write(output)
    print(output, end="")


if __name__ == "__main__":
    main()
