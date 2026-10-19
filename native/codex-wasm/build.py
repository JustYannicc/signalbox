#!/usr/bin/env python3.11
# pyright: reportImplicitRelativeImport=false
"""Build a pinned Codex release entirely in wrapper-owned output directories."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from binaryen import prepare_binaryen
from dependencies.url_stage import prepare_url_dependency
from overlay import apply_overlay
from sources import checkout, export_tree, read_pin, verify_checkout, verify_output_location
from sqlite import prepare_sqlite_dependencies
from toolchain import prepare_dependencies, prepare_wasi_toolchain
from wasi_reactor import prepare_wasi_reactor
from websocket import apply_websocket_overlay
from workspace import patch_lock_updates, prepare_workspace, verify_engine_graph

ROOT = Path(__file__).resolve().parent
TARGETS = ("wasm32-wasip1",)


def engine_outputs(target_dir: Path):
    module = target_dir / TARGETS[0] / "release" / "signalbox-codex-engine.wasm"
    if not module.is_file():
        raise ValueError(f"Cargo succeeded without producing {module.name}")
    return module


def command(args, *, cwd, env, capture=False):
    print("+ " + " ".join(map(str, args)), flush=True)
    result = subprocess.run(list(map(str, args)), cwd=cwd, env=env, check=True,
                            text=True, stdout=subprocess.PIPE if capture else None)
    return result.stdout


def build(args):
    if args.target not in TARGETS:
        raise ValueError(f"Unsupported build target: {args.target!r}")
    pin = read_pin(args.pin)
    if args.target not in pin["targets"]:
        raise ValueError("Target is not enabled by the release pin")
    cache = args.cache.resolve()
    source = checkout(cache / "sources", "codex", pin)
    before = verify_checkout(source, pin["commit"])
    references = {name: checkout(cache / "sources", name, spec)
                  for name, spec in pin["references"].items()}
    output = args.output.resolve() / f"{pin['version']}-{pin['commit'][:12]}" / args.target
    verify_output_location(output, [source, *references.values()])
    if output.exists():
        raise ValueError("Build output already exists; use a new --output directory")
    output.mkdir(parents=True)
    report: dict[str, object] = {"version": pin["version"], "upstreamCommit": pin["commit"],
              "target": args.target, "sourceSha256Before": before, "status": "building"}
    try:
        copied = output / "source"
        export_tree(source, copied, pin["commit"])
        report["overlay"] = apply_overlay(copied, args.target)
        report["overlay"] += apply_websocket_overlay(copied, args.target)
        patches = prepare_wasi_reactor(cache / "reactor", references,
                                       prepare_dependencies(cache, references))
        patches.update(prepare_url_dependency(cache, references))
        patches = prepare_sqlite_dependencies(cache / "sqlite", references, patches)
        workspace = prepare_workspace(copied, ROOT / "engine", patches, pin["version"])
        report["workspace"] = str(workspace.relative_to(output))
        if args.prepare_only:
            report["status"] = "prepared"
            return
        environment = os.environ.copy()
        toolchain = prepare_wasi_toolchain(cache, references)
        environment.update(toolchain)
        environment.update({"CARGO_TARGET_DIR": str(cache / "target" / pin["commit"] / args.target),
                            "CARGO_INCREMENTAL": "0", "CARGO_BUILD_JOBS": "2",
                            "CODEX_UPSTREAM_VERSION": pin["version"]})
        if environment["RUSTUP_TOOLCHAIN"] != pin["rust"]:
            raise ValueError("Prepared Rust toolchain does not match the pin")
        cargo = [environment["CARGO"]]
        for package, version in patch_lock_updates(workspace, patches):
            command([*cargo, "update", "--package", package, "--precise", version],
                    cwd=workspace, env=environment)
        metadata = json.loads(command(
            [*cargo, "metadata", "--format-version=1", "--filter-platform", args.target],
            cwd=workspace, env=environment, capture=True))
        report["packages"] = verify_engine_graph(metadata)
        (output / "cargo-graph.json").write_text(json.dumps(metadata, indent=2) + "\n")
        if args.check:
            # Check the shipping panic strategy; dev unwinding selects different wasm APIs.
            operation = ["check", "--release", "--bin", "signalbox-codex-engine"]
        else:
            operation = ["build", "--release", "--bin", "signalbox-codex-engine"]
        command([*cargo, *operation, "-p", "signalbox-codex-engine", "--target", args.target,
                 "-Z", "build-std=std,panic_abort"], cwd=workspace, env=environment)
        if args.check:
            report["status"] = "checked"
            return
        module = engine_outputs(Path(environment["CARGO_TARGET_DIR"]))
        artifact = output / "artifact"
        artifact.mkdir()
        command([prepare_binaryen(cache), "--all-features", "-Oz", module, "-o", artifact / "engine.wasm"],
                cwd=workspace, env=environment)
        shutil.copy2(workspace / "Cargo.lock", artifact / "Cargo.lock")
        shutil.copy2(ROOT / "loader.mjs", artifact / "loader.mjs")
        inventory = json.loads(command(["node", ROOT / "inspect.mjs", artifact / "engine.wasm"],
                                       cwd=workspace, env=environment, capture=True))
        manifest = {**inventory, "abiVersion": 1, "version": pin["version"], "upstreamCommit": pin["commit"],
                    "target": args.target, "sourceSha256": before,
                    "moduleSha256": hashlib.sha256((artifact / "engine.wasm").read_bytes()).hexdigest(),
                    "moduleBytes": (artifact / "engine.wasm").stat().st_size,
                    "moduleBudgetBytes": 60_000_000,
                    "moduleBudgetPassed": (artifact / "engine.wasm").stat().st_size < 60_000_000,
                    "cargoLockSha256": hashlib.sha256((artifact / "Cargo.lock").read_bytes()).hexdigest(),
                    "files": {file.name: {"sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
                                           "bytes": file.stat().st_size}
                              for file in sorted(artifact.iterdir())},
                    "proof": {"localWorkerd": "pending", "deployedDO": "pending"}}
        (artifact / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        if not manifest["moduleBudgetPassed"]:
            raise ValueError("engine.wasm exceeds the 60 million byte module budget")
        report["status"] = "built-unverified"
    except BaseException as error:
        report["status"] = "failed"
        report["error"] = str(error)
        raise
    finally:
        try:
            after = verify_checkout(source, pin["commit"])
            report["sourceSha256After"] = after
            if before != after:
                report["status"] = "failed"
                raise ValueError("Pristine Codex source hash changed during build")
            report["referenceSha256"] = {
                name: verify_checkout(path, pin["references"][name]["commit"])
                for name, path in references.items()
            }
        except BaseException as error:
            report["status"] = "failed"
            report["integrityError"] = str(error)
            raise
        finally:
            (output / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pin", type=Path, default=ROOT / "upstream.json")
    parser.add_argument("--target", choices=TARGETS, default=TARGETS[0])
    parser.add_argument("--cache", type=Path, default=ROOT / ".cache")
    parser.add_argument("--output", type=Path, default=ROOT / "build")
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if sys.version_info < (3, 11):
        parser.error("Python 3.11 or newer is required")
    build(args)


if __name__ == "__main__":
    main()
