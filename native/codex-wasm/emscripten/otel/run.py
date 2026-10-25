#!/usr/bin/env python3.11
"""Under heavy-slot, reproduce r10's OTLP error and check/link/run its correction."""
# pyright: reportImplicitRelativeImport=false

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tomllib

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from emscripten import NIGHTLY, prepare_emscripten_toolchain
from emscripten_deps import CRATES, prepare_emscripten_dependencies
from sources import read_pin, verify_checkout, verify_output_location
from workspace import patch_entries, write_toml

TARGET = "wasm32-unknown-emscripten"
NAME = "signalbox-otel-default-client-probe"
SELECTED = {"opentelemetry-otlp", "opentelemetry-http", "opentelemetry_sdk", "reqwest", "tokio"}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inventory(root):
    return {str(path.relative_to(root)): sha(path)
            for path in sorted(root.rglob("*")) if path.is_file()}


def selected(graph):
    packages = {p["id"]: p for p in graph["packages"]}
    return {p["name"]: {"version": p["version"], "features": node["features"]}
            for node in graph["resolve"]["nodes"] for p in [packages[node["id"]]]
            if p["name"] in SELECTED and not (p["name"] == "reqwest" and p["version"].startswith("0.13"))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--graph", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--reuse-target", type=Path, required=True)
    args = parser.parse_args()
    cache = ROOT / ".cache"
    pin = read_pin(ROOT / "upstream.json")
    sources = {name: cache / "sources" / name / spec["commit"] for name, spec in pin["references"].items()}
    sources["codex"] = cache / "sources/codex" / pin["commit"]
    output = args.output.resolve()
    verify_output_location(output, sources.values())
    if any(path.resolve().is_relative_to(output) for path in sources.values()):
        raise ValueError("probe output must not contain input checkouts")
    output.mkdir(parents=True, exist_ok=False)
    commits = {name: pin["commit"] if name == "codex" else pin["references"][name]["commit"] for name in sources}
    source_before = {name: verify_checkout(path, commits[name]) for name, path in sources.items()}
    rustcs = list(cache.glob(f"wasi-toolchain-*/rustup/toolchains/{NIGHTLY}-*/bin/rustc"))
    if len(rustcs) != 1 or not list(cache.glob("emsdk-*/.ready")):
        raise ValueError("probe requires the existing private Rust and Emscripten installations")
    rustc = rustcs[0]
    rustup = rustc.parents[3]
    cargo_home = rustup.parent / "cargo-home"
    registry = cargo_home / "registry/src/index.crates.io-1949cf8c6b5b557f"
    crates = [registry / (name + "-0.31.0") for name in ("opentelemetry-otlp", "opentelemetry-http")]
    registry_before = {str(path): inventory(path) for path in crates}
    registry_archives = [next((cargo_home / "registry/cache").glob("*/" + path.name + ".crate")) for path in crates]
    archives_before = {str(path): sha(path) for path in registry_archives}
    previous = {str(path): inventory(path) for path in cache.glob("emscripten-deps-*")}
    official_lock = sources["codex"] / "codex-rs/Cargo.lock"
    lock_pin = next(p for p in tomllib.loads(official_lock.read_text())["package"] if p["name"] == "opentelemetry-otlp")
    graph = json.loads(args.graph.read_text())
    expected = selected(graph)
    report: dict[str, object] = {"status": "preparing", "selected": expected, "sourceGraphSha256": sha(args.graph),
              "officialLockSha256": sha(official_lock), "sourceSha256Before": source_before,
              "registryBefore": registry_before,
              "registryArchiveSha256Before": archives_before,
              "probeSourceSha256": inventory(Path(__file__).parent),
              "coverage": "Default exporter construction and injected socket rejection only; no HTTP/TLS parity"}
    try:
        env = prepare_emscripten_toolchain(cache, {
            "RUSTC": str(rustc), "RUSTUP_HOME": str(rustup), "RUSTUP_TOOLCHAIN": NIGHTLY,
            "CARGO_HOME": str(cargo_home),
        })
        env.update({"CARGO_TARGET_DIR": str(args.reuse_target.resolve()), "CARGO_BUILD_JOBS": "2",
                    "CARGO_INCREMENTAL": "0", "CARGO_NET_OFFLINE": "true", "PYTHONDONTWRITEBYTECODE": "1"})
        flags = env["CARGO_ENCODED_RUSTFLAGS"].split("\x1f")
        libraries = [ROOT / "emscripten/patches/imports.js", ROOT / "emscripten/http/imports.js"]
        if any(flags.count(f"link-arg=--js-library={path}") != 1 for path in libraries):
            raise ValueError("probe must retain both encoded import libraries exactly once")
        if any("ERROR_ON_UNDEFINED_SYMBOLS" in flag for flag in flags):
            raise ValueError("probe must retain undefined-symbol errors")
        report.update({"rustflags": flags, "linkLibrarySha256": {str(p): sha(p) for p in libraries}})
        patches = prepare_emscripten_dependencies(cache, sources)
        archive = cache / "downloads/opentelemetry-otlp-0.31.0.crate"
        if CRATES["opentelemetry-otlp"] != (lock_pin["version"], lock_pin["checksum"]) or sha(archive) != lock_pin["checksum"]:
            raise ValueError("OTLP archive must match the official release lock")
        pristine = output / "pristine"
        with tarfile.open(archive, "r:gz") as contents:
            contents.extractall(pristine, filter="data")
        pristine = pristine / "opentelemetry-otlp-0.31.0"
        original = inventory(pristine)
        staged = inventory(patches["opentelemetry-otlp"])
        changed = [name for name in original if original[name] != staged[name]]
        if original.keys() != staged.keys() or changed != ["src/exporter/http/mod.rs"]:
            raise ValueError("OTLP patch changed unexpected files")
        file = "src/exporter/http/mod.rs"
        old = (pristine / file).read_text()
        new = (patches["opentelemetry-otlp"] / file).read_text()
        # Removing cfg attributes must leave byte-for-byte identical Rust bodies.
        import re
        strip_cfg = lambda text: re.sub(r"#\[cfg\(.*?\)\]\s*", "", text, flags=re.DOTALL)
        if strip_cfg(old) != strip_cfg(new):
            raise ValueError("OTLP patch changed code outside cfg attributes")
        report.update({"archiveSha256Before": sha(archive), "changedCrateFiles": changed,
                       "originalCrateSha256": original, "stagedCrateSha256": staged,
                       "stage": str(patches["opentelemetry-otlp"].parent), "constructorBodiesUnchanged": True})
        crate = output / "probe"
        (crate / "src").mkdir(parents=True)
        shutil.copyfile(Path(__file__).with_name("main.rs"), crate / "src/main.rs")
        source_manifest = next(p for p in graph["packages"] if p["name"] == "signalbox-codex-engine")["manifest_path"]
        manifest = tomllib.loads(Path(source_manifest).read_text())
        patch_map = manifest.get("patch", {}).get("crates-io", {})
        # The full workspace owns the patch table, which may be above the engine.
        workspace = Path(source_manifest).parent
        while "workspace" not in manifest:
            workspace = workspace.parent
            manifest = tomllib.loads((workspace / "Cargo.toml").read_text())
        patch_map = manifest["patch"]["crates-io"]
        patch_map.update(patch_entries(patches))
        dependencies = {name: {"version": "=" + spec["version"], "default-features": False, "features": spec["features"]}
                        for name, spec in expected.items()}
        document = {"package": {"name": NAME, "version": "0.1.0", "edition": "2021"}, "workspace": {},
                    "dependencies": dependencies, "patch": {"crates-io": patch_map},
                    "profile": {"release": {"panic": "abort", "opt-level": "z"}}}
        shutil.copyfile(workspace / "Cargo.lock", crate / "Cargo.lock")

        def cargo(operation, log, baseline=False):
            command = [env["CARGO"], operation, "--offline", "--release", "--bin", NAME,
                       "--target", TARGET, "-Z", "build-std=std,panic_abort"]
            print("+", " ".join(command), flush=True)
            result = subprocess.run(command, cwd=crate, env=env, text=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            (output / log).write_text(result.stdout)
            print(result.stdout[-6000:], flush=True)
            if baseline:
                if result.returncode == 0 or "error[E0277]" not in result.stdout or "reqwest::blocking::Client: HttpClient" not in result.stdout:
                    raise ValueError("baseline did not reproduce r10's exact E0277")
            else:
                result.check_returncode()

        patch_map["opentelemetry-otlp"] = {"path": str(pristine)}
        write_toml(crate / "Cargo.toml", document)
        report["status"] = "baseline-check"
        cargo("check", "baseline-check.log", baseline=True)
        report["baselineExactE0277"] = True
        patch_map["opentelemetry-otlp"] = {"path": str(patches["opentelemetry-otlp"])}
        write_toml(crate / "Cargo.toml", document)
        metadata = subprocess.run([env["CARGO"], "metadata", "--offline", "--format-version=1", "--filter-platform", TARGET],
                                  cwd=crate, env=env, check=True, text=True, stdout=subprocess.PIPE).stdout
        (output / "cargo-graph.json").write_text(metadata)
        if selected(json.loads(metadata)) != expected:
            raise ValueError(f"probe selected features differ from r10: {selected(json.loads(metadata))}")
        report["exactSelectedFeatures"] = True
        for operation in ("check", "build"):
            report["status"] = operation
            cargo(operation, operation + ".log")
        release = args.reuse_target / TARGET / "release"
        artifact = output / "artifact"
        artifact.mkdir()
        for source, name in ((release / (NAME + ".js"), "engine.mjs"),
                             (release / (NAME.replace("-", "_") + ".wasm"), "engine.wasm"),
                             (ROOT / "loader-emscripten.mjs", "loader.mjs"),
                             (Path(__file__).with_name("runtime.mjs"), "runtime.mjs")):
            shutil.copyfile(source, artifact / name)
        report["status"] = "jspi-runtime"
        runtime = subprocess.run([shutil.which("node") or "node", "--experimental-wasm-jspi", artifact / "runtime.mjs"],
                                 cwd=artifact, env=env, text=True, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, timeout=60)
        (output / "runtime.log").write_text(runtime.stdout)
        print(runtime.stdout, flush=True)
        runtime.check_returncode()
        report["artifactSha256"] = inventory(artifact)
        report["status"] = "check-link-jspi-passed"
    except BaseException as error:
        report.update({"failedStage": report["status"], "status": "failed", "error": str(error)})
        raise
    finally:
        report["archiveSha256After"] = sha(cache / "downloads/opentelemetry-otlp-0.31.0.crate")
        report["registryArchiveSha256After"] = {str(path): sha(path) for path in registry_archives}
        report["archivesUnchanged"] = (archives_before == report["registryArchiveSha256After"]
                                       and report.get("archiveSha256Before") == report["archiveSha256After"])
        report["sourceSha256After"] = {name: verify_checkout(path, commits[name]) for name, path in sources.items()}
        report["registryUnchanged"] = registry_before == {str(path): inventory(path) for path in crates}
        report["previousStagesUnchanged"] = all(inventory(Path(path)) == files for path, files in previous.items())
        report["sourcesUnchanged"] = source_before == report["sourceSha256After"]
        integrity = all(report[key] for key in ("registryUnchanged", "previousStagesUnchanged", "sourcesUnchanged", "archivesUnchanged"))
        if not integrity:
            report["status"] = "integrity-failed"
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        if not integrity:
            raise ValueError("input integrity failed")


if __name__ == "__main__":
    main()
