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


def release_at(manifest_path: Path, commit: str) -> dict[str, Any]:
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        fail(
            "Pass a full good manifest commit, chosen from successful release evidence."
        )
    root = Path(
        subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"], text=True
        ).strip()
    )
    relative_path = manifest_path.resolve().relative_to(root).as_posix()
    if (
        subprocess.run(
            ["git", "merge-base", "--is-ancestor", commit, "HEAD"], check=False
        ).returncode
        != 0
    ):
        fail("The good manifest commit must be an ancestor of this checkout's HEAD.")
    good = json.loads(
        subprocess.check_output(["git", "show", f"{commit}:{relative_path}"], text=True)
    )
    if not isinstance(good, dict):
        fail("The good manifest must be a JSON object.")
    validate_release(good)
    return good


def held_rollback(
    manifest_path: Path, current: dict[str, Any], body_path: Path
) -> None:
    blocked = matching_holds(current["version"], current)
    if not blocked:
        print(json.dumps({"rollback": False}))
        return
    usable = [
        entry
        for entry in blocked
        if not matching_holds(entry["lastGood"]["version"], current)
    ]
    if not usable:
        fail("Every evidenced rollback target is held; the pin needs a hand.")
    selected = max(
        usable,
        key=lambda entry: (
            semver(entry["lastGood"]["version"]),
            entry["lastGood"]["commit"],
        ),
    )
    good = release_at(manifest_path, selected["lastGood"]["commit"])
    if good["version"] != selected["lastGood"]["version"]:
        fail("The evidenced good version does not match its manifest commit.")
    # Keep main's current metadata exactly, including human lifts and range edits.
    updated = {**good, "holds": holds(current)}
    body = [
        f"The pinned CLIProxyAPI {current['version']} is held. Restore the full evidenced {good['version']} manifest, including its source commit, platform assets and checksums.",
        "",
        f"Good manifest commit: `{selected['lastGood']['commit']}`",
        f"Good release evidence: {selected['lastGood']['evidence']}",
        "",
    ]
    for entry in blocked:
        body.extend(
            [
                entry["reason"],
                f"Reproduction: {entry['reproduction']}",
                f"Upstream issue: {entry['upstreamIssue']}",
                "",
            ]
        )
    body.append(
        "The final hold recheck leaves a seconds-long race; if a held pin merges, the next release-sync check automatically prepares this rollback through the same smoke, deploy and CI gates."
    )
    body_path.write_text("\n".join(body) + "\n", encoding="utf-8")
    manifest_path.write_text(f"{json.dumps(updated, indent=2)}\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "rollback": True,
                "previous": current["version"],
                "version": good["version"],
            }
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--held", action="store_true")
    parser.add_argument("--pr-body", type=Path)
    for option in (
        "expected-version",
        "good-commit",
        "good-evidence",
        "reproduction",
        "upstream-issue",
        "reason",
    ):
        parser.add_argument(f"--{option}")
    args = parser.parse_args()

    manifest_path = args.manifest.resolve()
    current = read_json(manifest_path)
    if args.held:
        if args.pr_body is None:
            parser.error("--held requires --pr-body")
        held_rollback(manifest_path, current, args.pr_body)
        return
    if any(
        getattr(args, field) is None
        for field in (
            "expected_version",
            "good_commit",
            "good_evidence",
            "reproduction",
            "upstream_issue",
            "reason",
        )
    ):
        parser.error("Supply all manual rollback evidence, or use --held --pr-body.")
    if current.get("version") != args.expected_version:
        fail(
            "The pinned version changed; diagnose the current release before rolling it back."
        )
    good = release_at(manifest_path, args.good_commit)
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
