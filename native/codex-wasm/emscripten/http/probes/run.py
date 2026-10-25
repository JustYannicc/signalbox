#!/usr/bin/env python3.11
"""Run under heavy-slot. Compile/link the pinned HTTP carrier; never send HTTP."""
# pyright: reportImplicitRelativeImport=false
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from emscripten import NIGHTLY, prepare_emscripten_toolchain
from emscripten_deps import prepare_emscripten_dependencies
from emscripten_http import prepare_emscripten_http
from sources import read_pin, verify_checkout, verify_output_location
from workspace import patch_entries, write_toml

TARGET = "wasm32-unknown-emscripten"
NAME = "signalbox-http-boundary"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--graph", type=Path, required=True)
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
    inputs = {name: verify_checkout(path, pin["commit"] if name == "codex" else pin["references"][name]["commit"])
              for name, path in sources.items()}
    report: dict[str, object] = {"status": "preparing", "sourceSha256Before": inputs,
                                "coverage": "compile/link/import inventory; no HTTP execution"}
    try:
        rustcs = sorted(cache.glob(f"wasi-toolchain-*/rustup/toolchains/{NIGHTLY}-*/bin/rustc"))
        if len(rustcs) != 1:
            raise ValueError("exactly one existing private Rust install is required")
        rustc = rustcs[0]
        rustup = rustc.parents[3]
        env = prepare_emscripten_toolchain(cache, {
            "RUSTC": str(rustc), "RUSTUP_HOME": str(rustup), "RUSTUP_TOOLCHAIN": NIGHTLY,
            "CARGO_HOME": str(rustup.parent / "cargo-home"),
        })
        flags = env["CARGO_ENCODED_RUSTFLAGS"].split("\x1f")
        for library in ("emscripten/patches/imports.js", "emscripten/http/imports.js"):
            library_arg = "link-arg=--js-library=" + str(ROOT / library)
            if flags.count(library_arg) != 1:
                raise ValueError(f"prepared SDK must select {library} exactly once")
        env.update({"CARGO_ENCODED_RUSTFLAGS": "\x1f".join(flags),
                    "CARGO_HOME": str(output / "cargo-home"), "CARGO_TARGET_DIR": str(output / "target"),
                    "CARGO_BUILD_JOBS": "2", "CARGO_INCREMENTAL": "0", "CARGO_PROFILE_DEV_PANIC": "abort",
                    "CARGO_PROFILE_DEV_DEBUG": "0", "PYTHONDONTWRITEBYTECODE": "1"})
        patches = {**prepare_emscripten_dependencies(cache, sources), **prepare_emscripten_http(cache, sources)}
        graph = json.loads(args.graph.read_text())
        requested = sorted({feature for package in graph["packages"] for dep in package["dependencies"]
                            if dep["name"] == "reqwest" and "0.12" in dep["req"] for feature in dep["features"]})
        expected = {"blocking", "cookies", "json", "rustls-tls", "rustls-tls-native-roots", "stream"}
        if not expected.issubset(requested):
            raise ValueError(f"Codex HTTP feature coverage changed: {requested}")
        crate = output / "probe"
        (crate / "src").mkdir(parents=True)
        shutil.copyfile(Path(__file__).with_name("main.rs"), crate / "src/main.rs")
        write_toml(crate / "Cargo.toml", {
            "package": {"name": NAME, "version": "0.1.0", "edition": "2021"}, "workspace": {},
            "dependencies": {"reqwest": {"version": "=0.12.28", "features": requested},
                             "serde_json": "1", "libc": "=0.2.186", "socket2": {"version": "=0.6.5", "features": ["all"]},
                             "tokio": {"version": "=1.52.3", "features": ["full", "test-util"]}},
            "patch": {"crates-io": patch_entries(patches)},
        })
        report.update({"requestedReqwestFeatures": requested, "rustflags": flags,
                       "helperSha256": hashlib.sha256((ROOT / "emscripten_http.py").read_bytes()).hexdigest(),
                       "patchSha256": hashlib.sha256((ROOT / "emscripten/http/reuse.patch").read_bytes()).hexdigest(),
                       "librarySha256": hashlib.sha256((ROOT / "emscripten/http/imports.js").read_bytes()).hexdigest()})
        for operation in ("check", "build"):
            report["status"] = operation
            subprocess.run([env["CARGO"], operation, "--bin", NAME, "--target", TARGET,
                            "-Z", "build-std=std,panic_abort"], cwd=crate, env=env, check=True)
        artifact = output / "artifact"
        artifact.mkdir()
        built = output / "target" / TARGET / "debug"
        for source, name in [(built / (NAME.replace("-", "_") + ".wasm"), "engine.wasm"),
                             (built / (NAME + ".js"), "engine.mjs"),
                             (ROOT / "loader-emscripten.mjs", "loader.mjs"),
                             (ROOT / "emscripten/host.mjs", "host.mjs"),
                             (Path(__file__).with_name("inventory.mjs"), "inventory.mjs")]:
            shutil.copyfile(source, artifact / name)
        report["status"] = "inventory"
        node = shutil.which("node")
        if node is None:
            raise ValueError("Node is required for the probe")
        subprocess.run([node, "--experimental-wasm-jspi", str(artifact / "inventory.mjs")],
                       cwd=artifact, env=env, check=True, timeout=30)
        report["artifactSha256"] = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                                   for path in artifact.iterdir() if path.is_file()}
        report["status"] = "compile-link-inventory-passed"
    except BaseException as error:
        report.update({"failedStage": report["status"], "status": "failed", "error": str(error)})
        raise
    finally:
        after = {name: verify_checkout(path, pin["commit"] if name == "codex" else pin["references"][name]["commit"])
                 for name, path in sources.items()}
        report["sourceSha256After"] = after
        if inputs != after:
            report.update({"status": "failed", "integrityError": "source checkout changed"})
        (output / "probe-report.json").write_text(json.dumps(report, indent=2) + "\n")
        if inputs != after:
            raise ValueError("source checkout changed")


if __name__ == "__main__":
    main()
