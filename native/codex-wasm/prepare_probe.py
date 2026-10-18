#!/usr/bin/env python3.11
"""Produce an #1057 fixture from a built Codex artifact."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parent


def prepare(artifact: Path, output: Path):
    info = json.loads((artifact / "manifest.json").read_text())
    if info["target"] != "wasm32-wasip1":
        raise ValueError("Only wasm32-wasip1 artifacts are supported")
    module = artifact / "engine.wasm"
    if hashlib.sha256(module.read_bytes()).hexdigest() != info["moduleSha256"]:
        raise ValueError("Engine module hash differs from its manifest")
    if module.stat().st_size != info["moduleBytes"]:
        raise ValueError("Engine module byte count differs from its manifest")
    for name, expected in info["files"].items():
        file = artifact / name
        if file.name != name or file.stat().st_size != expected["bytes"] or hashlib.sha256(file.read_bytes()).hexdigest() != expected["sha256"]:
            raise ValueError(f"Artifact file differs from its manifest: {name}")
    output.mkdir(parents=True, exist_ok=False)
    shutil.copy2(module, output / "engine.wasm")
    shutil.copy2(artifact / "loader.mjs", output / "loader.mjs")
    shutil.copy2(ROOT / "probe.mjs", output / "main.js")
    (output / "engine-info.mjs").write_text("export const info = " + json.dumps(info) + ";\n")
    modules = {"main.js": {"path": "main.js", "type": "js"},
                    "loader.mjs": {"path": "loader.mjs", "type": "js"},
                    "engine-info.mjs": {"path": "engine-info.mjs", "type": "js"},
                    "engine.wasm": {"path": "engine.wasm", "type": "wasm"}}
    fixture = {
        "id": re.sub(r"[^A-Za-z0-9-]", "-", "codex-" + info["version"] + "-" + info["target"]),
        "mainModule": "main.js", "entrypoint": "ProbeFacet", "modules": modules,
        "paths": ["/status", "/version"],
    }
    (output / "manifest.json").write_text(json.dumps(fixture, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    prepare(args.artifact, args.output)
