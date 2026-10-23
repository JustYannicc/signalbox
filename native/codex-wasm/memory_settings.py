"""Verify upstream memory defaults before adding them to the package's default layer."""

import json
import subprocess
import tomllib
from pathlib import Path

from workspace import write_toml


def pin_memory_settings(source: Path):
    repository = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        [
            "node",
            repository / "scripts/harness-releases/checkMemorySettings.ts",
            "codex",
            source,
        ],
        cwd=repository,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    evidence = json.loads(result.stdout)
    defaults = source / "codex-rs/config/defaults.toml"
    values = tomllib.loads(defaults.read_text())
    for name, value in evidence["pins"].items():
        parts = name.split(".")
        table = values
        for part in parts[:-1]:
            table = table.setdefault(part, {})
        # This is the native packaged layer, so user/managed/CLI configuration still wins.
        table[parts[-1]] = value
    write_toml(defaults, values)
    return evidence
