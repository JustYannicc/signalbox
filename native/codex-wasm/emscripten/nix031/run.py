#!/usr/bin/env python3.11
"""Under heavy-slot, reproduce r13's nix features, then check/link its exact features."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from emscripten import NIGHTLY, prepare_emscripten_toolchain
from emscripten_deps import prepare_emscripten_dependencies
from workspace import write_toml
from reuse import VERSION, CHECKSUM, adapt

TARGET = "wasm32-unknown-emscripten"
NAME = "signalbox-nix031-errno-probe"


def inventory(root):
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(root.rglob("*")) if path.is_file()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--graph", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache", type=Path, default=ROOT / ".cache")
    parser.add_argument("--reuse-target", type=Path, required=True)
    parser.add_argument("--baseline-log", type=Path, required=True)
    args = parser.parse_args()
    cache, output = args.cache.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    installed = list(cache.glob(f"wasi-toolchain-*/rustup/toolchains/{NIGHTLY}-*/bin/rustc"))
    if len(installed) != 1 or not list(cache.glob("emsdk-*/.ready")):
        raise ValueError("probe requires the already installed Rust and Emscripten SDK")
    rustc = installed[0]
    rustup = rustc.parents[3]
    cargo_home = rustup.parent / "cargo-home"
    archives = cargo_home / "registry/cache/index.crates.io-1949cf8c6b5b557f"
    sdk_evidence = json.loads((Path(__file__).parents[1] / "nix/sdk-evidence.json").read_text())
    sdk = cache / "emsdk-4.0.10-62a853cd3b31/upstream/emscripten"
    if sdk_evidence["sha256"] != {file: hashlib.sha256((sdk / file).read_bytes()).hexdigest()
                                   for file in sdk_evidence["sha256"]}:
        raise ValueError("SDK sources/libraries changed since verified ABI inspection")
    registries = [cargo_home / "registry/src/index.crates.io-1949cf8c6b5b557f" / f"nix-{v}"
                  for v in ("0.28.0", "0.31.3")]
    inputs_before = {str(path): inventory(path) for path in registries}
    old_stages = {str(path): inventory(path) for path in cache.glob("emscripten-deps-*")}
    graph = json.loads(args.graph.read_text())
    packages = {package["id"]: package for package in graph["packages"]}
    nodes = {node["id"]: node for node in graph["resolve"]["nodes"]}
    nix = next(p for p in packages.values() if (p["name"], p["version"]) == ("nix", VERSION))
    nix_node = nodes[nix["id"]]
    selected = {p["name"]: {"version": p["version"], "features": nodes[p["id"]]["features"]}
                for p in [nix, *[packages[d["pkg"]] for d in nix_node["deps"]
                                 if d["name"] != "cfg_aliases"]]}
    report = {"status": "preparing", "selected": selected,
              "sourceGraphSha256": hashlib.sha256(args.graph.read_bytes()).hexdigest(),
              "archiveSha256": CHECKSUM,
              "coverage": "nix 0.31.3 signals reject/noop and Ems FS compatibility only; no OS signals, PTYs or processes"}
    try:
        base = {"RUSTC": str(rustc), "RUSTUP_HOME": str(rustup), "RUSTUP_TOOLCHAIN": NIGHTLY,
                "CARGO_HOME": str(cargo_home)}
        env = prepare_emscripten_toolchain(cache, base)
        env.update({"CARGO_TARGET_DIR": str(args.reuse_target.resolve()), "CARGO_BUILD_JOBS": "2",
                    "CARGO_INCREMENTAL": "0", "CARGO_NET_OFFLINE": "true"})
        report["rustflags"] = env["CARGO_ENCODED_RUSTFLAGS"].split("\x1f")
        for path in (ROOT / "emscripten/patches/imports.js", ROOT / "emscripten/http/imports.js"):
            if report["rustflags"].count(f"link-arg=--js-library={path}") != 1:
                raise ValueError("probe must keep both original link libraries exactly once")
        report["linkLibrarySha256"] = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
                                      for path in (ROOT / "emscripten/patches/imports.js",
                                                   ROOT / "emscripten/http/imports.js")}
        paths = prepare_emscripten_dependencies(cache, {"codex": cache / "sources/codex"})
        for file, candidate in adapt(archives).items():
            if (paths["nix_031"] / file).read_text() != candidate:
                raise ValueError(f"staged nix {file} differs from verified carrier backport")
        report["stage"] = str(paths["nix_031"].parent)
        report["frozenSha256"] = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
                                  for path in (ROOT / "emscripten_deps.py", ROOT / "emscripten/patches/nix_031.patch")}
        baseline_log = args.baseline_log
        baseline = baseline_log.read_text()
        if not ("nix-0.31.3/src/" in baseline
                and all(f"cannot find function `{name}` in crate `libc`" in baseline
                        for name in ("sigwait", "pthread_sigmask", "faccessat"))):
            raise ValueError("prior full-graph log does not reproduce the three missing libc declarations")
        report["baselineEvidence"] = {"path": str(baseline_log),
                                      "sha256": hashlib.sha256(baseline_log.read_bytes()).hexdigest()}
        for label, path in (("patched", paths["nix_031"]),):
            crate = output / label
            (crate / "src").mkdir(parents=True)
            shutil.copyfile(Path(__file__).with_name("main.rs"), crate / "src/main.rs")
            dependencies = {name: {"version": "=" + spec["version"], "default-features": False,
                                   "features": spec["features"]} for name, spec in selected.items()}
            dependencies["nix"]["path"] = str(path)
            write_toml(crate / "Cargo.toml", {
                "package": {"name": NAME, "version": "0.1.0", "edition": "2021"}, "workspace": {},
                "dependencies": dependencies, "profile": {"release": {"panic": "abort", "opt-level": "z"}},
            })
            metadata = subprocess.run([env["CARGO"], "metadata", "--offline", "--format-version=1",
                                       "--filter-platform", TARGET], cwd=crate, env=env, check=True,
                                      text=True, stdout=subprocess.PIPE).stdout
            (crate / "cargo-graph.json").write_text(metadata)
            resolved = json.loads(metadata)
            ids = {p["id"]: p for p in resolved["packages"]}
            activated = {ids[n["id"]]["name"]: {"version": ids[n["id"]]["version"], "features": n["features"]}
                         for n in resolved["resolve"]["nodes"] if ids[n["id"]]["name"] in selected}
            if activated != selected:
                raise ValueError(f"probe features differ from r13: {activated} != {selected}")
            for operation in ("check", "build"):
                report["status"] = f"{label}-{operation}"
                command = [env["CARGO"], operation, "--offline", "--release", "--bin", NAME,
                           "--target", TARGET, "-Z", "build-std=std,panic_abort"]
                print("+", " ".join(command), "in", crate, flush=True)
                result = subprocess.run(command, cwd=crate, env=env, text=True,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                log = output / f"{label}-{operation}.log"
                log.write_text(result.stdout)
                print(result.stdout, flush=True)
                result.check_returncode()
        aliases = {str(path): path.read_text() for path in args.reuse_target.glob(
            f"{TARGET}/release/build/nix-*/output")}
        if not aliases or any("cargo:rustc-cfg=" in text for text in aliases.values()):
            raise ValueError("unexpected nix platform alias for Emscripten")
        report["buildScriptCfgOutputs"] = aliases
        release = args.reuse_target / TARGET / "release"
        artifacts = [release / (NAME + ".js"), release / (NAME.replace("-", "_") + ".wasm")]
        report["artifacts"] = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in artifacts}
        artifact = output / "artifact"
        artifact.mkdir()
        for source, name in ((artifacts[0], "engine.mjs"), (artifacts[1], "engine.wasm"),
                             (ROOT / "loader-emscripten.mjs", "loader.mjs"),
                             (Path(__file__).with_name("runtime.mjs"), "runtime.mjs")):
            shutil.copyfile(source, artifact / name)
        report["status"] = "jspi-runtime"
        node = shutil.which("node")
        if node is None:
            raise ValueError("Node is required for the probe")
        runtime = subprocess.run([node, "--experimental-wasm-jspi", artifact / "runtime.mjs"],
                                 cwd=artifact, env=env, text=True, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, timeout=60)
        (output / "runtime.log").write_text(runtime.stdout)
        print(runtime.stdout, flush=True)
        runtime.check_returncode()
        report["status"] = "check-link-jspi-passed"
    except BaseException as error:
        report.update({"failedStage": report["status"], "status": "failed", "error": str(error)})
        raise
    finally:
        report["registryUnchanged"] = inputs_before == {str(path): inventory(path) for path in registries}
        report["oldStagesUnchanged"] = all(inventory(Path(path)) == before for path, before in old_stages.items())
        if not report["registryUnchanged"]:
            report["status"] = "input-integrity-failed"
        if not report["oldStagesUnchanged"]:
            report["status"] = "old-stage-integrity-failed"
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        if report["status"].endswith("integrity-failed"):
            raise ValueError(report["status"])
        print(report["status"], flush=True)


if __name__ == "__main__":
    main()
