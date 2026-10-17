"""Prepare a local rollback manifest after an upstream regression is reproduced."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path
from typing import Any

from .release_policy import fail, holds, matching_holds, read_json, semver
from .update import CONTAINER_ARCHIVE, PLATFORMS


def validate_release(manifest: dict[str, Any]) -> None:
    version = manifest.get("version")
    semver(version)
    source = manifest.get("source", {})
    if not isinstance(source, dict) or not re.fullmatch(
        r"[a-f0-9]{40}", str(source.get("commit", ""))
    ):
        fail("The good manifest must contain its full upstream source commit.")
    platforms = manifest.get("platforms")
    if not isinstance(platforms, dict) or set(platforms) != set(PLATFORMS):
        fail("The good manifest must contain every self-hosted platform asset.")

    def check_asset(asset: Any, name: str) -> None:
        if not isinstance(asset, dict) or asset.get("name") != name:
            fail(f"The good manifest must contain the matching asset {name}.")
        size = asset.get("bytes")
        if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
            fail(f"The good manifest has no valid size for {name}.")
        if not re.fullmatch(r"[a-f0-9]{64}", str(asset.get("sha256", ""))):
            fail(f"The good manifest has no valid checksum for {name}.")

    for platform, arch in PLATFORMS.items():
        extension = "zip" if platform.startswith("win32-") else "tar.gz"
        check_asset(platforms[platform], f"CLIProxyAPI_{version}_{arch}.{extension}")
    check_asset(manifest.get("container"), CONTAINER_ARCHIVE.format(version=version))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--expected-version", required=True)
    parser.add_argument("--good-commit", required=True)
    parser.add_argument("--good-evidence", required=True)
    parser.add_argument("--reproduction", required=True)
    parser.add_argument("--upstream-issue", required=True)
    parser.add_argument("--reason", required=True)
    args = parser.parse_args()

    if not re.fullmatch(r"[a-f0-9]{40}", args.good_commit):
        fail(
            "Pass a full good manifest commit, chosen from successful release evidence."
        )
    root = Path(
        subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"], text=True
        ).strip()
    )
    manifest_path = args.manifest.resolve()
    relative_path = manifest_path.relative_to(root).as_posix()
    current = read_json(manifest_path)
    if current.get("version") != args.expected_version:
        fail(
            "The pinned version changed; diagnose the current release before rolling it back."
        )
    if (
        subprocess.run(
            ["git", "merge-base", "--is-ancestor", args.good_commit, "HEAD"],
            check=False,
        ).returncode
        != 0
    ):
        fail("The good manifest commit must be an ancestor of this checkout's HEAD.")
    good = json.loads(
        subprocess.check_output(
            ["git", "show", f"{args.good_commit}:{relative_path}"], text=True
        )
    )
    if not isinstance(good, dict):
        fail("The good manifest must be a JSON object.")
    validate_release(good)
    if semver(good["version"]) >= semver(args.expected_version):
        fail(
            "The good manifest must pin an older release than the reproduced bad version."
        )

    hold = {
        "from": args.expected_version,
        "reason": args.reason,
        "upstreamIssue": args.upstream_issue,
        "reproduction": args.reproduction,
        "lastGood": {
            "commit": args.good_commit,
            "version": good["version"],
            "evidence": args.good_evidence,
        },
    }
    # Old snapshots must not resurrect a range somebody has since lifted.
    updated = {**good}
    updated["holds"] = [*holds(current), hold]
    if matching_holds(good["version"], updated):
        fail(
            "The proposed good release is itself held; choose a verified unheld release."
        )
    manifest_path.write_text(f"{json.dumps(updated, indent=2)}\n", encoding="utf-8")
    print(f"Prepared rollback from {args.expected_version} to {good['version']}.")
    print(f"Reproduction: {args.reproduction}\nUpstream issue: {args.upstream_issue}")
    print(f"Good release evidence: {args.good_evidence}")


if __name__ == "__main__":
    main()
