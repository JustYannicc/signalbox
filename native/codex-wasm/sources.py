"""Pinned, read-only inputs for the Codex wrapper build."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
from typing import TypedDict, Union


class SourceSpec(TypedDict):
    repository: str
    commit: str


class Pin(SourceSpec):
    version: str
    tag: str
    rust: str
    targets: list[str]
    references: dict[str, SourceSpec]


def git(root: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def read_pin(path: Path) -> Pin:
    pin: Pin = json.loads(path.read_text())
    if not re.fullmatch(r"\d+\.\d+\.\d+", pin["version"]):
        raise ValueError("Codex version must be a stable release")
    if pin["tag"] != "rust-v" + pin["version"]:
        raise ValueError("Codex tag and version disagree")
    for source in [pin, *pin["references"].values()]:
        if not re.fullmatch(r"[0-9a-f]{40}", source["commit"]):
            raise ValueError("Every source needs a full Git commit")
        if not source["repository"].startswith("https://github.com/"):
            raise ValueError("Source repositories must use GitHub HTTPS")
    return pin


def checkout(cache: Path, name: str, spec: Union[SourceSpec, Pin]) -> Path:
    root = cache / name / spec["commit"]
    if not (root / ".git").exists():
        root.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="checkout-", dir=root.parent) as temporary:
            staging = Path(temporary)
            subprocess.run(["git", "init", "--quiet", str(staging)], check=True)
            subprocess.run(
                ["git", "-C", str(staging), "fetch", "--quiet", "--depth=1",
                 spec["repository"], spec["tag"] if "tag" in spec else spec["commit"]], check=True,
            )
            if git(staging, "rev-parse", "FETCH_HEAD^{commit}") != spec["commit"]:
                raise ValueError(f"{name}: fetched ref does not match the pinned commit")
            subprocess.run(["git", "-C", str(staging), "checkout", "--quiet", "--detach",
                            spec["commit"]], check=True)
            staging.rename(root)
    verify_checkout(root, spec["commit"])
    return root


def verify_checkout(root: Path, commit: str) -> str:
    if git(root, "rev-parse", "HEAD") != commit:
        raise ValueError("Source HEAD does not match the pin")
    # Untracked files count too: builds must never write into their input tree.
    if git(root, "status", "--porcelain", "--untracked-files=all", "--ignored"):
        raise ValueError("Source checkout is not pristine")
    digest = hashlib.sha256()
    index = subprocess.check_output(["git", "-C", str(root), "ls-files", "--stage", "-z"])
    for entry in index.split(b"\0"):
        if not entry:
            continue
        metadata, path = entry.split(b"\t", 1)
        mode, _, stage = metadata.split(b" ")
        if stage != b"0" or mode not in (b"100644", b"100755", b"120000"):
            raise ValueError("Source has an unresolved entry or unsupported submodule")
        file = root / os.fsdecode(path)
        data = os.fsencode(os.readlink(file)) if mode == b"120000" else file.read_bytes()
        digest.update(mode + b" " + path + b"\0")
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
    return digest.hexdigest()


def export_tree(root: Path, destination: Path, commit: str) -> None:
    if destination.exists():
        raise ValueError("Refusing to overwrite an existing compile overlay")
    destination.mkdir(parents=True)
    with tempfile.TemporaryFile() as archive:
        subprocess.run(["git", "-C", str(root), "archive", commit], stdout=archive, check=True)
        archive.seek(0)
        with tarfile.open(fileobj=archive) as contents:
            contents.extractall(destination, filter="data")


def verify_output_location(output: Path, inputs) -> None:
    output = output.resolve()
    for source in inputs:
        if output.is_relative_to(source.resolve()):
            raise ValueError("Build output must not be inside an input checkout")
