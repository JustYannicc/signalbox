#!/usr/bin/env python3.11
"""Under heavy-slot, check/link r9's serial2 features and assert rejection in JSPI."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from emscripten import NIGHTLY, prepare_emscripten_toolchain
from emscripten_deps import CRATES, prepare_emscripten_dependencies
from workspace import write_toml

TARGET = "wasm32-unknown-emscripten"
NAME = "signalbox-serial-break-probe"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inventory(root):
    return {str(path.relative_to(root)): sha(path)
            for path in sorted(root.rglob("*")) if path.is_file()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--graph", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--reuse-target", type=Path, required=True)
    parser.add_argument("--cache", type=Path, default=ROOT / ".cache")
    args = parser.parse_args()
    cache, output = args.cache.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    installed = list(cache.glob(f"wasi-toolchain-*/rustup/toolchains/{NIGHTLY}-*/bin/rustc"))
    if len(installed) != 1 or not list(cache.glob("emsdk-*/.ready")):
        raise ValueError("probe requires already installed Rust and Emscripten")
    rustc = installed[0]
    rustup = rustc.parents[3]
    cargo_home = rustup.parent / "cargo-home"
    registry = cargo_home / "registry/src/index.crates.io-1949cf8c6b5b557f/serial2-0.2.33"
    before = inventory(registry)
    previous = {str(path): inventory(path) for path in cache.glob("emscripten-deps-*")}
    sdk = cache / "emsdk-4.0.10-62a853cd3b31/upstream/emscripten/src/lib/libsyscall.js"
    evidence = json.loads(Path(__file__).with_name("sdk-evidence.json").read_text())
    if sha(sdk) != evidence["sdkIoctlSha256"] or any(
            name in sdk.read_text() for name in ("TIOCSBRK", "TIOCCBRK")):
        raise ValueError("SDK serial ioctl evidence changed")
    graph = json.loads(args.graph.read_text())
    packages = {p["id"]: p for p in graph["packages"]}
    nodes = {n["id"]: n for n in graph["resolve"]["nodes"]}
    serial = next(p for p in packages.values() if p["name"] == "serial2")
    selected = {p["name"]: {"version": p["version"], "features": nodes[p["id"]]["features"]}
                for p in [serial, *[packages[d["pkg"]] for d in nodes[serial["id"]]["deps"]]]}
    report = {"status": "preparing", "selected": selected, "sourceGraphSha256": sha(args.graph),
              "sdkIoctlSha256": sha(sdk), "registryBefore": before,
              "coverage": "serial break rejection only; no serial device or PTY support claimed"}
    try:
        base = {"RUSTC": str(rustc), "RUSTUP_HOME": str(rustup), "RUSTUP_TOOLCHAIN": NIGHTLY,
                "CARGO_HOME": str(cargo_home)}
        env = prepare_emscripten_toolchain(cache, base)
        env.update({"CARGO_TARGET_DIR": str(args.reuse_target.resolve()), "CARGO_BUILD_JOBS": "2",
                    "CARGO_INCREMENTAL": "0", "CARGO_NET_OFFLINE": "true"})
        report["rustflags"] = env["CARGO_ENCODED_RUSTFLAGS"].split("\x1f")
        libraries = [ROOT / "emscripten/patches/imports.js", ROOT / "emscripten/http/imports.js"]
        if any(report["rustflags"].count(f"link-arg=--js-library={p}") != 1 for p in libraries):
            raise ValueError("probe must retain both original link libraries exactly once")
        report["linkLibrarySha256"] = {str(p.relative_to(ROOT)): sha(p) for p in libraries}
        paths = prepare_emscripten_dependencies(cache, {"codex": cache / "sources/codex"})
        archive = cache / "downloads/serial2-0.2.33.crate"
        if sha(archive) != CRATES["serial2"][1] or CRATES["serial2"][0] != "0.2.33":
            raise ValueError("serial2 archive pin changed")
        with tarfile.open(archive, "r:gz") as contents:
            original = {}
            for entry in contents:
                if entry.isfile():
                    member = contents.extractfile(entry)
                    if member is None:
                        raise ValueError("Crate archive member is not a file")
                    original[entry.name.removeprefix("serial2-0.2.33/")] = member.read()
        staged = {str(p.relative_to(paths["serial2"])): p.read_bytes()
                  for p in paths["serial2"].rglob("*") if p.is_file()}
        changed = [name for name in original if original[name] != staged[name]]
        if original.keys() != staged.keys() or changed != ["src/sys/unix/mod.rs"]:
            raise ValueError("serial2 patch changed unexpected files")
        file = "src/sys/unix/mod.rs"
        anchor = b'\tpub fn set_break(&self, enable: bool) -> std::io::Result<()> {'
        start = original[file].index(anchor)
        end = original[file].index(b'\n\t}\n', start) + len(b'\n\t}\n')
        native = original[file][start:end]
        if b'\t#[cfg(not(target_os = "emscripten"))]\n' + native not in staged[file]:
            raise ValueError("native set_break body changed")
        report.update({"nativeMethodSha256": hashlib.sha256(native).hexdigest(),
                       "archiveSha256": sha(archive), "changedCrateFiles": changed,
                       "stage": str(paths["serial2"].parent)})
        crate = output / "probe"
        (crate / "src").mkdir(parents=True)
        shutil.copyfile(Path(__file__).with_name("main.rs"), crate / "src/main.rs")
        dependencies = {name: {"version": "=" + spec["version"], "default-features": False,
                               "features": spec["features"]} for name, spec in selected.items()}
        dependencies["serial2"]["path"] = str(paths["serial2"])
        write_toml(crate / "Cargo.toml", {
            "package": {"name": NAME, "version": "0.1.0", "edition": "2021"}, "workspace": {},
            "dependencies": dependencies, "profile": {"release": {"panic": "abort", "opt-level": "z"}},
        })
        metadata = subprocess.run([env["CARGO"], "metadata", "--offline", "--format-version=1",
                                   "--filter-platform", TARGET], cwd=crate, env=env, check=True,
                                  text=True, stdout=subprocess.PIPE).stdout
        (output / "cargo-graph.json").write_text(metadata)
        resolved = json.loads(metadata)
        ids = {p["id"]: p for p in resolved["packages"]}
        activated = {ids[n["id"]]["name"]: {"version": ids[n["id"]]["version"], "features": n["features"]}
                     for n in resolved["resolve"]["nodes"] if ids[n["id"]]["name"] in selected}
        if activated != selected:
            raise ValueError(f"probe differs from r9: {activated} != {selected}")
        for operation in ("check", "build"):
            report["status"] = operation
            command = [env["CARGO"], operation, "--offline", "--release", "--bin", NAME,
                       "--target", TARGET, "-Z", "build-std=std,panic_abort"]
            print("+", " ".join(command), flush=True)
            result = subprocess.run(command, cwd=crate, env=env, text=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            (output / f"{operation}.log").write_text(result.stdout)
            print(result.stdout, flush=True)
            result.check_returncode()
        release = args.reuse_target / TARGET / "release"
        artifact = output / "artifact"
        artifact.mkdir()
        for source, name in ((release / (NAME + ".js"), "engine.mjs"),
                             (release / (NAME.replace("-", "_") + ".wasm"), "engine.wasm"),
                             (ROOT / "loader-emscripten.mjs", "loader.mjs"),
                             (Path(__file__).with_name("runtime.mjs"), "runtime.mjs")):
            shutil.copyfile(source, artifact / name)
        report["artifactSha256"] = inventory(artifact)
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
        report["registryUnchanged"] = before == inventory(registry)
        report["previousStagesUnchanged"] = all(inventory(Path(p)) == files for p, files in previous.items())
        if not (report["registryUnchanged"] and report["previousStagesUnchanged"]):
            report["status"] = "integrity-failed"
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        if report["status"] == "integrity-failed":
            raise ValueError(report["status"])
        print(report["status"], flush=True)


if __name__ == "__main__":
    main()
