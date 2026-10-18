"""Release holds shared by the updater, rollback preparation and merge gate."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any, NoReturn
from urllib.parse import urlsplit


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        fail(f"Expected a JSON object in {path}.")
    return value


def semver(value: Any) -> tuple[int, int, int]:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", value):
        fail(f"Expected a stable x.y.z CLIProxyAPI version, got {value!r}.")
    major, minor, patch = value.split(".")
    return int(major), int(minor), int(patch)


def evidence_url(value: Any) -> bool:
    if not isinstance(value, str) or any(c.isspace() for c in value):
        return False
    url = urlsplit(value)
    return (
        url.scheme == "https"
        and bool(url.hostname)
        and not url.username
        and not url.password
    )


def holds(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    entries = manifest.get("holds", [])
    if not isinstance(entries, list):
        fail("CLIProxyAPI holds must be an array.")
    for entry in entries:
        if not isinstance(entry, dict):
            fail("Each CLIProxyAPI hold must be an object.")
        start = semver(entry.get("from"))
        if "before" in entry and semver(entry["before"]) <= start:
            fail("A CLIProxyAPI hold's exclusive 'before' must be newer than 'from'.")
        reason = entry.get("reason")
        if (
            not isinstance(reason, str)
            or not reason.strip()
            or len(reason.splitlines()) != 1
        ):
            fail("A CLIProxyAPI hold needs a one-line reason.")
        issue = entry.get("upstreamIssue")
        if not isinstance(issue, str) or not re.fullmatch(
            r"https://github\.com/router-for-me/CLIProxyAPI/issues/[1-9][0-9]*", issue
        ):
            fail("A CLIProxyAPI hold needs an upstream CLIProxyAPI issue URL.")
        if not evidence_url(entry.get("reproduction")):
            fail("A CLIProxyAPI hold needs an HTTPS reproduction evidence URL.")
        good = entry.get("lastGood")
        if not isinstance(good, dict) or not re.fullmatch(
            r"[a-f0-9]{40}", str(good.get("commit", ""))
        ):
            fail("A CLIProxyAPI hold needs a full lastGood manifest commit.")
        if semver(good.get("version")) >= start or not evidence_url(
            good.get("evidence")
        ):
            fail(
                "A CLIProxyAPI hold needs an older lastGood version and HTTPS evidence URL."
            )
    return entries


def matching_holds(version: str, *manifests: dict[str, Any]) -> list[dict[str, Any]]:
    candidate = semver(version)
    # Validate every entry, including ranges that don't cover this version.
    entries = [entry for manifest in manifests for entry in holds(manifest)]
    return [
        entry
        for entry in entries
        if semver(entry["from"]) <= candidate
        and ("before" not in entry or candidate < semver(entry["before"]))
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("current", type=Path)
    parser.add_argument("version")
    parser.add_argument("candidate", type=Path, nargs="?")
    parser.add_argument("branch_base", type=Path, nargs="?")
    parser.add_argument("--backstop", action="store_true")
    args = parser.parse_args()
    current = read_json(args.current)
    manifests = [current]
    candidate = read_json(args.candidate) if args.candidate else {}
    # Sync may refresh a stale PR after a person lifts a hold on main.
    # Preserve holds introduced by an unmerged rollback instead.
    if args.candidate and (
        args.branch_base is None
        or holds(candidate) != holds(read_json(args.branch_base))
    ):
        manifests.append(candidate)
    blocked = matching_holds(args.version, *manifests)
    stale = args.backstop and (
        not matching_holds(current["version"], current)
        or holds(candidate) != holds(current)
    )
    print(json.dumps({"held": bool(blocked), "holds": blocked, "staleRollback": stale}))


if __name__ == "__main__":
    main()
