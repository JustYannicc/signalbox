#!/usr/bin/env python3.11
"""Run under heavy-slot. Reproduce Ring's cfg failure, then link and test real Emscripten output."""
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

from emscripten import EMSDK_COMMIT, NIGHTLY, SDK_RELEASE, SDK_VERSION, prepare_emscripten_toolchain
from emscripten_crypto import CRATES, prepare_emscripten_crypto
from sources import read_pin, verify_checkout
from workspace import write_toml

TARGET = "wasm32-unknown-emscripten"
NAME = "signalbox-emscripten-ring-boundary"


def command(args, cwd, env, log: Path, expect_failure=False):
    print("+ " + " ".join(map(str, args)), flush=True)
    result = subprocess.run(list(map(str, args)), cwd=cwd, env=env, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600)
    log.write_text(result.stdout + result.stderr)
    if expect_failure:
        if result.returncode == 0 or not all(text in result.stderr for text in (
                "SystemRandom", "ring::rand::SecureRandom", "could not compile `rustls`")):
            raise ValueError(f"pristine probe did not reproduce the Ring trait failure: {log}")
    else:
        if result.returncode:
            print(result.stderr[-6000:], flush=True)
        result.check_returncode()
    return result.stdout


def activated(graph):
    packages = {package["id"]: package for package in graph["packages"]}
    return {f'{packages[node["id"]]["name"]}@{packages[node["id"]]["version"]}': node["features"]
            for node in graph["resolve"]["nodes"]}


def prove_runtime(output, env, node, report):
    artifact = output / "artifact"
    artifact.mkdir()
    built = output / "target" / TARGET / "debug" / NAME
    shutil.copyfile(built.with_name(NAME.replace("-", "_")).with_suffix(".wasm"), artifact / "engine.wasm")
    shutil.copyfile(built.with_suffix(".js"), artifact / "engine.mjs")
    shutil.copyfile(ROOT / "loader-emscripten.mjs", artifact / "loader.mjs")
    shutil.copyfile(Path(__file__).with_name("host.mjs"), artifact / "host.mjs")
    report["artifactSha256"] = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                                for path in artifact.iterdir()}
    result = command([node, "--experimental-wasm-jspi", artifact / "host.mjs"], artifact, env,
                     output / "runtime.log")
    print(result, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=ROOT / ".cache")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--graph", type=Path, required=True)
    parser.add_argument("--node", default=shutil.which("node"))
    args = parser.parse_args()
    cache, output = args.cache.resolve(), args.output.resolve()
    pin = read_pin(ROOT / "upstream.json")
    sources = {name: cache / "sources" / name / spec["commit"] for name, spec in pin["references"].items()}
    sources["codex"] = cache / "sources/codex" / pin["commit"]
    if output == cache or cache.is_relative_to(output) or output.is_relative_to(cache):
        raise ValueError("probe output must be separate from the installed cache")
    if any(output.is_relative_to(path.resolve()) or path.resolve().is_relative_to(output) for path in sources.values()):
        raise ValueError("probe output must not contain or be inside source checkouts")
    output.mkdir(parents=True, exist_ok=False)
    before = verify_checkout(sources["codex"], pin["commit"])
    report: dict[str, object] = {"coverage": "Ring/Rustls RNG boundary; synthetic Node host; no TLS/full Codex turn",
              "codexCommit": pin["commit"], "sourceSha256Before": before, "status": "preparing"}
    try:
        installed = sorted(cache.glob(f"wasi-toolchain-*/rustup/toolchains/{NIGHTLY}-*/bin/rustc"))
        if len(installed) != 1:
            raise ValueError("expected one installed private Rust toolchain; probe never installs Rust/WASI")
        sdk = cache / f"emsdk-{SDK_VERSION}-{EMSDK_COMMIT[:12]}"
        if not (sdk / ".ready").is_file():
            raise ValueError("SDK must already be installed; probe never installs the SDK")
        report["sdk"] = {"version": SDK_VERSION, "emsdkCommit": EMSDK_COMMIT, "release": SDK_RELEASE}
        inputs = [ROOT / "emscripten.py", ROOT / "emscripten_crypto.py", ROOT / "loader-emscripten.mjs",
                  ROOT / "emscripten/patches/imports.js", Path(__file__), Path(__file__).with_name("main.rs"),
                  Path(__file__).with_name("host.mjs"), args.graph.resolve(),
                  sdk / "upstream/emscripten/system/lib/libc/musl/src/misc/getentropy.c",
                  sdk / "upstream/emscripten/src/lib/libwasi.js"]
        report["inputSha256"] = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in inputs}
        rustc = installed[0]
        rustup = rustc.parents[3]
        env = prepare_emscripten_toolchain(cache, {
            "RUSTC": str(rustc), "RUSTUP_HOME": str(rustup), "RUSTUP_TOOLCHAIN": NIGHTLY,
            "CARGO_HOME": str(rustup.parent / "cargo-home"),
        })
        env.update({"CARGO_HOME": str(output / "cargo-home"), "CARGO_TARGET_DIR": str(output / "target"),
                    "CARGO_BUILD_JOBS": "2", "CARGO_INCREMENTAL": "0", "CARGO_PROFILE_DEV_PANIC": "abort",
                    "CARGO_PROFILE_DEV_DEBUG": "0", "PYTHONDONTWRITEBYTECODE": "1"})
        if not args.node:
            raise ValueError("a JSPI-capable Node executable is required")
        command([args.node, "--experimental-wasm-jspi", "-e",
                 "if(typeof WebAssembly.Suspending!=='function'||typeof WebAssembly.promising!=='function')process.exit(1);console.log(process.version)"],
                output, env, output / "node.log")
        parent = activated(json.loads(args.graph.read_text()))
        expected = {name: features for name, features in parent.items()
                    if name in {"ring@0.17.14", "getrandom@0.2.17", "libc@0.2.186"}}
        if len(expected) != 3:
            raise ValueError("parent graph no longer matches the pinned RNG boundary")
        rustls = [name for name in parent if name.startswith("rustls@")]
        if len(rustls) != 1:
            raise ValueError("expected exactly one Rustls version in parent graph")
        crate = output / "probe"
        (crate / "src").mkdir(parents=True)
        shutil.copyfile(Path(__file__).with_name("main.rs"), crate / "src/main.rs")
        dependencies = {name.split("@")[0]: {"version": "=" + name.split("@")[1],
                       "default-features": False, "features": features} for name, features in expected.items()}
        dependencies["rustls"] = {"version": "=" + rustls[0].split("@")[1], "default-features": False,
                                  "features": ["ring", "std", "tls12", "logging"]}
        manifest = {"package": {"name": NAME, "version": "0.1.0", "edition": "2021"},
                    "workspace": {}, "dependencies": dependencies}
        write_toml(crate / "Cargo.toml", manifest)
        report["status"] = "pristine-check"
        cargo_args = ["--bin", NAME, "--target", TARGET, "-Z", "build-std=std,panic_abort"]
        command([env["CARGO"], "check", *cargo_args], crate, env, output / "pristine-check.log", True)
        report["pristineFailureReproduced"] = True
        patches = prepare_emscripten_crypto(output / "dependencies", sources)
        manifest["patch"] = {"crates-io": {name: {"path": str(path)} for name, path in patches.items()}}
        write_toml(crate / "Cargo.toml", manifest)
        metadata = json.loads(command([env["CARGO"], "metadata", "--format-version=1", "--filter-platform", TARGET],
                                      crate, env, output / "metadata.log"))
        (output / "cargo-graph.json").write_text(json.dumps(metadata, indent=2) + "\n")
        actual = activated(metadata)
        if any(actual.get(name) != features for name, features in expected.items()):
            raise ValueError("probe RNG dependency versions/features differ from parent graph")
        ring = next(package for package in metadata["packages"] if package["name"] == "ring")
        if Path(ring["manifest_path"]).parent != patches["ring"]:
            raise ValueError("Cargo did not select the prepared Ring copy")
        report.update({"activated": actual, "rngExpected": expected, "cratePins": CRATES,
                       "patches": {name: str(path) for name, path in patches.items()},
                       "cryptoInventorySha256": hashlib.sha256((patches["ring"].parent / ".ready").read_bytes()).hexdigest(),
                       "patchSha256": hashlib.sha256((ROOT / "emscripten/crypto/ring.patch").read_bytes()).hexdigest(),
                       "rustflags": env["CARGO_ENCODED_RUSTFLAGS"].split("\x1f")})
        for operation in ("check", "build"):
            report["status"] = operation
            command([env["CARGO"], operation, *cargo_args], crate, env, output / f"{operation}.log")
        report["status"] = "runtime"
        prove_runtime(output, env, args.node, report)
        report["status"] = "passed"
    except BaseException as error:
        report.update({"failedStage": report["status"], "status": "failed", "error": str(error)})
        raise
    finally:
        try:
            after = verify_checkout(sources["codex"], pin["commit"])
            report["sourceSha256After"] = after
            if before != after:
                raise ValueError("original Codex source changed")
        except BaseException as error:
            report.update({"status": "failed", "integrityError": str(error)})
            raise
        finally:
            (output / "probe-report.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
