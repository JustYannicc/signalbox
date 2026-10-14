#!/usr/bin/env python3
"""Update Signalbox's CLIProxyAPI pins from one verified upstream release."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any, NoReturn


ASSETS = {
    "darwin-arm64": "darwin_aarch64",
    "darwin-x64": "darwin_amd64",
    "linux-arm64": "linux_aarch64",
    "linux-x64": "linux_amd64",
    "win32-arm64": "windows_aarch64",
    "win32-x64": "windows_amd64",
}

FORMAT_PATH = re.compile(
    r"(^|[._-])(config|auth|oauth|credentials?|store|storage|migration|schema)([._-]|$)",
    re.IGNORECASE,
)
FORMAT_NOTES = re.compile(
    r"\b(?:breaking(?: change)?|migrat(?:e|ion)|"
    r"config(?:uration)?\s+(?:format|schema|version|migration)|"
    r"(?:auth|authentication|credential|token)\s+(?:file|format|schema|migration)|"
    r"(?:format|schema|migration)\s+(?:of\s+)?(?:config|auth|authentication|credential|token))\b",
    re.IGNORECASE,
)


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def semver(value: str) -> tuple[int, ...]:
    if not re.fullmatch(r"\d+(?:\.\d+){2}", value):
        fail(f"Expected a stable x.y.z CLIProxyAPI version, got {value!r}.")
    return tuple(int(part) for part in value.split("."))


def main() -> None:
    if len(sys.argv) != 6:
        fail("usage: update.py release.json checksums.txt compare.json Dockerfile AccountHubRelease.ts")

    release_path, checksums_path, compare_path, docker_path, account_hub_path = map(Path, sys.argv[1:])
    release = read_json(release_path)
    compare = read_json(compare_path)
    tag = release.get("tag_name", "")
    match = re.fullmatch(r"v(\d+(?:\.\d+){2})", tag)
    if not match or release.get("draft") or release.get("prerelease"):
        fail(f"Expected a stable vX.Y.Z release, got {tag!r}.")
    version = match.group(1)

    dockerfile = docker_path.read_text(encoding="utf-8")
    account_hub = account_hub_path.read_text(encoding="utf-8")
    docker_version = re.findall(r"^ARG VERSION=(\S+)$", dockerfile, re.MULTILINE)
    docker_sha = re.findall(r"^ARG SHA256=(\S+)$", dockerfile, re.MULTILINE)
    hub_version = re.findall(r'^export const ACCOUNT_HUB_VERSION = "([^"]+)";$', account_hub, re.MULTILINE)
    if len(docker_version) != 1 or len(docker_sha) != 1 or len(hub_version) != 1:
        fail("Expected one Docker version/hash pin and one account-hub version pin.")
    previous = docker_version[0]
    if hub_version[0] != previous:
        fail(f"The pins are already split: Dockerfile={previous}, AccountHubRelease={hub_version[0]}.")
    if semver(version) <= semver(previous):
        fail(f"Upstream release {version} is not newer than the pinned {previous}.")

    checksums: dict[str, str] = {}
    for line in checksums_path.read_text(encoding="utf-8").splitlines():
        fields = line.split()
        if len(fields) >= 2:
            checksums[fields[-1].lstrip("*").rsplit("/", 1)[-1]] = fields[0].lower()
    release_assets = {asset["name"]: asset for asset in release.get("assets", [])}

    def asset(name: str) -> tuple[int, str]:
        metadata = release_assets.get(name)
        checksum = checksums.get(name, "")
        if not metadata or not re.fullmatch(r"[a-f0-9]{64}", checksum):
            fail(f"Release is missing the asset or its SHA-256 in checksums.txt: {name}")
        size = metadata.get("size")
        if not isinstance(size, int) or size <= 0:
            fail(f"Release has no valid size for {name}.")
        return size, checksum

    image_name = f"CLIProxyAPI_{version}_linux_amd64_no-plugin.tar.gz"
    _, image_sha = asset(image_name)
    dockerfile = re.sub(r"^ARG VERSION=\S+$", f"ARG VERSION={version}", dockerfile, count=1, flags=re.MULTILINE)
    dockerfile = re.sub(r"^ARG SHA256=\S+$", f"ARG SHA256={image_sha}", dockerfile, count=1, flags=re.MULTILINE)

    generated_assets = []
    for platform, arch in ASSETS.items():
        suffix = "zip" if platform.startswith("win32-") else "tar.gz"
        name = f"CLIProxyAPI_{version}_{arch}.{suffix}"
        size, checksum = asset(name)
        formatted_size = format(size, ",").replace(",", "_")
        generated_assets.append(
            f'  "{platform}": {{\n'
            f'    name: "{name}",\n'
            f"    bytes: {formatted_size},\n"
            f'    sha256: "{checksum}",\n'
            "  },"
        )
    assets_block = "const ASSETS: Record<string, AccountHubAsset> = {\n" + "\n".join(generated_assets) + "\n};"
    account_hub = re.sub(
        r'^export const ACCOUNT_HUB_VERSION = "[^"]+";$',
        f'export const ACCOUNT_HUB_VERSION = "{version}";',
        account_hub,
        count=1,
        flags=re.MULTILINE,
    )
    account_hub, asset_count = re.subn(
        r"const ASSETS: Record<string, AccountHubAsset> = \{.*?\n\};",
        assets_block,
        account_hub,
        count=1,
        flags=re.DOTALL,
    )
    if asset_count != 1:
        fail("Could not replace the account-hub asset table.")

    docker_path.write_text(dockerfile, encoding="utf-8")
    account_hub_path.write_text(account_hub, encoding="utf-8")

    reasons: list[str] = []
    if compare.get("status") != "ahead":
        reasons.append("upstream compare is not a simple forward range")
    if int(compare.get("total_commits", 0)) > 50:
        reasons.append("more than 50 upstream commits need review")
    files = compare.get("files")
    if not isinstance(files, list) or len(files) >= 300:
        reasons.append("upstream file comparison is incomplete or at its API limit")
    else:
        for changed in files:
            name = changed.get("filename", "")
            components = name.split("/")
            if any(component.lower() in {"config", "auth", "oauth", "credential", "credentials", "store", "storage", "migration", "schema"} for component in components):
                reasons.append("upstream changed a format-sensitive path")
                print(f"Format-sensitive upstream path: {name!r}", file=sys.stderr)
                break
            if FORMAT_PATH.search(components[-1]):
                reasons.append("upstream changed a format-sensitive file")
                print(f"Format-sensitive upstream file: {name!r}", file=sys.stderr)
                break
    if FORMAT_NOTES.search(release.get("body") or ""):
        reasons.append("upstream release notes mention a format, schema, or migration change")
    reasons = list(dict.fromkeys(reasons))

    output_path = os.environ.get("GITHUB_OUTPUT")
    output = f"version={version}\nprevious_version={previous}\nrequires_review={'true' if reasons else 'false'}\n"
    output += f"review_reasons={' ; '.join(reasons) if reasons else 'none'}\n"
    if output_path:
        with open(output_path, "a", encoding="utf-8") as output_file:
            output_file.write(output)
    print(output, end="")


if __name__ == "__main__":
    main()
