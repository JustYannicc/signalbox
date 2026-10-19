#!/usr/bin/env python3.11
"""Run under heavy-slot. Link and run a synthetic JSPI Tokio/Mio boundary probe."""
# pyright: reportImplicitRelativeImport=false

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from emscripten import NIGHTLY, prepare_emscripten_toolchain
from emscripten_deps import prepare_emscripten_dependencies
from sources import read_pin, verify_checkout
from workspace import patch_entries, write_toml

TARGET = "wasm32-unknown-emscripten"
NAME = "signalbox-emscripten-tokio-boundary"


def command(args, cwd, env, capture=False):
    print("+ " + " ".join(map(str, args)), flush=True)
    return subprocess.run(list(map(str, args)), cwd=cwd, env=env, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def prove_runtime(build_output: Path, output: Path, env, node, report: dict[str, object]):
    artifact = output / "artifact"
    artifact.mkdir()
    built = build_output / "target" / TARGET / "debug" / NAME
    shutil.copyfile(built.with_name(NAME.replace("-", "_")).with_suffix(".wasm"), artifact / "engine.wasm")
    shutil.copyfile(built.with_suffix(".js"), artifact / "engine.mjs")
    shutil.copyfile(ROOT / "loader-emscripten.mjs", artifact / "loader.mjs")
    shutil.copyfile(ROOT / "emscripten/host.mjs", artifact / "host.mjs")
    shutil.copyfile(Path(__file__).with_name("synthetic-host.mjs"), artifact / "synthetic-host.mjs")
    report["artifactSha256"] = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                                for path in artifact.iterdir() if path.is_file()}
    report["moduleBytes"] = (artifact / "engine.wasm").stat().st_size
    report["moduleSha256"] = hashlib.sha256((artifact / "engine.wasm").read_bytes()).hexdigest()
    report["loaderSha256"] = hashlib.sha256((artifact / "loader.mjs").read_bytes()).hexdigest()
    report["hostSha256"] = hashlib.sha256((artifact / "host.mjs").read_bytes()).hexdigest()
    kernel = Path(env["SIGNALBOX_KERNEL_ABI_MODULE"]) if env.get("SIGNALBOX_KERNEL_ABI_MODULE") else ROOT.parent.parent / "apps/cloud/src/kernel/KernelAbi.ts"
    kernel_inputs = [kernel, kernel.with_name("KernelWakeRegistry.ts")]
    report["kernelInputSha256"] = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in kernel_inputs}
    report["status"] = "synthetic-runtime"
    # A failure watchdog, never a condition the test waits for to pass.
    result = subprocess.run([node, "--experimental-wasm-jspi", str(artifact / "synthetic-host.mjs")],
                            cwd=artifact, env=env, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=60)
    (output / "runtime.log").write_text(result.stdout)
    print(result.stdout, flush=True)
    result.check_returncode()
    if report["kernelInputSha256"] != {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in kernel_inputs}:
        raise ValueError("shared kernel inputs changed during runtime proof")
    report["status"] = "synthetic-runtime-passed"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=ROOT / ".cache")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--graph", type=Path, required=True)
    parser.add_argument("--node", default=shutil.which("node"))
    args = parser.parse_args()
    cache = args.cache.resolve()
    output = args.output.resolve()
    pin = read_pin(ROOT / "upstream.json")
    sources = {name: cache / "sources" / name / spec["commit"] for name, spec in pin["references"].items()}
    sources["codex"] = cache / "sources/codex" / pin["commit"]
    if any(output.is_relative_to(path.resolve()) or path.resolve().is_relative_to(output) for path in sources.values()):
        raise ValueError("probe output must not contain or be inside source checkouts")
    output.mkdir(parents=True, exist_ok=False)
    before = verify_checkout(sources["codex"], pin["commit"])
    report: dict[str, object] = {"coverage": "synthetic host, runtime boundary only", "sourceSha256Before": before,
              "status": "preparing"}
    try:
        installed = sorted(cache.glob(f"wasi-toolchain-*/rustup/toolchains/{NIGHTLY}-*/bin/rustc"))
        if len(installed) != 1:
            raise ValueError("expected exactly one installed private Rust toolchain; probe never installs Rust/WASI")
        rustc = installed[0]
        rustup = rustc.parents[3]
        base = {"RUSTC": str(rustc), "RUSTUP_HOME": str(rustup), "RUSTUP_TOOLCHAIN": NIGHTLY,
                "CARGO_HOME": str(rustup.parent / "cargo-home")}
        env = prepare_emscripten_toolchain(cache, base)
        library_arg = "link-arg=--js-library=" + str(ROOT / "emscripten/patches/imports.js")
        if env["CARGO_ENCODED_RUSTFLAGS"].split("\x1f").count(library_arg) != 1:
            raise ValueError("prepared SDK must select the host import library exactly once")
        env.setdefault("SIGNALBOX_KERNEL_ABI_MODULE", str(ROOT.parent.parent / "apps/cloud/src/kernel/KernelAbi.ts"))
        env.update({"CARGO_HOME": str(output / "cargo-home"), "CARGO_TARGET_DIR": str(output / "target"),
                    "CARGO_BUILD_JOBS": "2", "CARGO_INCREMENTAL": "0", "CARGO_PROFILE_DEV_PANIC": "abort",
                    "CARGO_PROFILE_DEV_DEBUG": "0", "PYTHONDONTWRITEBYTECODE": "1"})
        if not args.node:
            raise ValueError("a JSPI-capable Node executable is required")
        command([args.node, "--experimental-wasm-jspi", "-e",
                 "if(typeof WebAssembly.Suspending!=='function'||typeof WebAssembly.promising!=='function')process.exit(1);console.log(process.version)"], output, env)
        graph = json.loads(args.graph.read_text())
        packages = {package["id"]: package for package in graph["packages"]}
        expected = {packages[node["id"]]["name"]: (packages[node["id"]]["version"], node["features"])
                    for node in graph["resolve"]["nodes"] if packages[node["id"]]["name"] in {"tokio", "mio", "socket2", "libc"}}
        patches = prepare_emscripten_dependencies(output / "dependencies", sources)
        # Use the same checksum-pinned compatible socket2 selection as the wrapper.
        socket_package = tomllib.loads((patches["socket2"] / "Cargo.toml").read_text())["package"]
        expected["socket2"] = (socket_package["version"], expected["socket2"][1])
        crate = output / "probe"
        (crate / "src").mkdir(parents=True)
        shutil.copyfile(Path(__file__).with_name("main.rs"), crate / "src/main.rs")
        write_toml(crate / "Cargo.toml", {
            "package": {"name": NAME, "version": "0.1.0", "edition": "2021"}, "workspace": {},
            "dependencies": {
                "tokio": {"version": "=" + expected["tokio"][0], "features": ["full", "test-util"]},
                "mio": {"version": "=" + expected["mio"][0], "features": ["net", "os-ext", "os-poll"]},
                "socket2": {"version": "=" + expected["socket2"][0], "features": ["all"]},
                "libc": {"version": "=" + expected["libc"][0], "features": expected["libc"][1]},
            },
            "patch": {"crates-io": patch_entries(patches)},
        })
        metadata = json.loads(command([env["CARGO"], "metadata", "--format-version=1", "--filter-platform", TARGET], crate, env, True))
        (output / "cargo-graph.json").write_text(json.dumps(metadata, indent=2))
        ids = {package["id"]: package for package in metadata["packages"]}
        activated = {ids[node["id"]]["name"]: (ids[node["id"]]["version"], node["features"])
                     for node in metadata["resolve"]["nodes"] if ids[node["id"]]["name"] in expected}
        if activated != expected:
            raise ValueError(f"probe features/versions differ from full engine: {activated!r} != {expected!r}")
        report["activated"] = activated
        report["rustflags"] = env["CARGO_ENCODED_RUSTFLAGS"].split("\x1f")
        report["patches"] = {name: str(path) for name, path in patches.items()}
        report["helperSha256"] = hashlib.sha256((ROOT / "emscripten_deps.py").read_bytes()).hexdigest()
        report["linkLibrarySha256"] = hashlib.sha256((ROOT / "emscripten/patches/imports.js").read_bytes()).hexdigest()
        report["patchSha256"] = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                                 for path in (ROOT / "emscripten/patches").glob("*.patch")}
        for operation in ("check", "build"):
            report["status"] = operation
            command([env["CARGO"], operation, "--bin", NAME, "--target", TARGET,
                     "-Z", "build-std=std,panic_abort"], crate, env)
        prove_runtime(output, output, env, args.node, report)
    except BaseException as error:
        report["failedStage"] = report["status"]
        report["status"] = "failed"
        report["error"] = str(error)
        raise
    finally:
        try:
            after = verify_checkout(sources["codex"], pin["commit"])
            report["sourceSha256After"] = after
            if before != after:
                raise ValueError("original Codex source changed")
        except BaseException as error:
            report["status"] = "failed"
            report["integrityError"] = str(error)
            raise
        finally:
            (output / "probe-report.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
