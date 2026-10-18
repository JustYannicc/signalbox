"""Generate the build workspace without changing the pinned checkout."""

import json
from pathlib import Path
import shutil
import tomllib


def toml_value(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (str, int, float)):
        return json.dumps(value)
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{ " + ", ".join(json.dumps(key) + " = " + toml_value(item)
                                  for key, item in value.items()) + " }"
    raise ValueError(f"Unsupported Cargo manifest value: {type(value).__name__}")


def write_toml(path: Path, data):
    lines = []

    def table(values, keys):
        if keys:
            lines.extend(["", "[" + ".".join(json.dumps(key) for key in keys) + "]"])
        for key, value in values.items():
            if not isinstance(value, dict):
                lines.append(json.dumps(key) + " = " + toml_value(value))
        for key, value in values.items():
            if isinstance(value, dict):
                table(value, [*keys, key])

    table(data, [])
    output = "\n".join(lines).lstrip() + "\n"
    # Round-tripping prevents the generator from silently changing Cargo semantics.
    if tomllib.loads(output) != data:
        raise ValueError("Generated Cargo manifest did not round-trip")
    path.write_text(output)


def prepare_workspace(source: Path, engine: Path, patches, version: str) -> Path:
    root = source / "codex-rs"
    manifest = root / "Cargo.toml"
    data = tomllib.loads(manifest.read_text())
    name = "signalbox-wasm-engine"
    data["workspace"]["members"] = [name]
    data["workspace"]["default-members"] = [name]
    # Official release packaging stamps this same workspace version from its tag.
    data["workspace"]["package"]["version"] = version
    replacements = data.setdefault("patch", {}).setdefault("crates-io", {})
    for alias, path in patches.items():
        package = tomllib.loads((path / "Cargo.toml").read_text())["package"]["name"]
        replacements[alias] = {"path": str(path.resolve())}
        if alias != package:
            replacements[alias]["package"] = package
    data["profile"]["release"] = {
        "opt-level": "z", "lto": "thin", "codegen-units": 16,
        "debug": False, "strip": "symbols", "panic": "abort",
    }
    shutil.copytree(engine, root / name)
    write_toml(manifest, data)
    return root


def verify_engine_graph(metadata):
    packages = {package["id"]: package for package in metadata["packages"]}
    engines = [package for package in packages.values()
               if package["name"] == "signalbox-codex-engine"]
    if len(engines) != 1:
        raise ValueError("Expected exactly one wrapper engine in the Cargo graph")
    nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
    pending = [engines[0]["id"]]
    reached = set()
    forbidden = {"codex-cli", "codex-tui", "codex-exec", "codex-code-mode-host", "codex-v8-poc"}
    while pending:
        node = pending.pop()
        if node in reached:
            continue
        reached.add(node)
        name = packages[node]["name"]
        if name in forbidden:
            raise ValueError(f"Native CLI/TUI dependency in engine graph: {name}")
        pending.extend(dependency["pkg"] for dependency in nodes[node]["deps"]
                       if any(kind["kind"] != "dev" for kind in dependency["dep_kinds"]))
    return sorted(packages[package]["name"] for package in reached)


def patch_lock_updates(root: Path, patches):
    """Select wrapper replacements even when the release lock pins an older patch."""
    lock = tomllib.loads((root / "Cargo.lock").read_text())
    updates = []

    def compatibility(version):
        numbers = version.split("-", 1)[0].split(".", 2)
        if numbers[0] != "0":
            return numbers[0]
        return ".".join(numbers[:2] if numbers[1] != "0" else numbers)

    versions = {}
    for path in patches.values():
        package = tomllib.loads((path / "Cargo.toml").read_text())["package"]
        desired = package["version"]
        key = (package["name"], compatibility(desired))
        if key in versions and versions[key] != desired:
            raise ValueError(f"Ambiguous patch versions for {key[0]} {key[1]}")
        versions[key] = desired
    for package in lock["package"]:
        desired = versions.get((package["name"], compatibility(package["version"])))
        if (desired and package.get("source", "").startswith("registry+")
                and package["version"] != desired):
            updates.append((package["name"] + "@" + package["version"], desired))
    return updates
