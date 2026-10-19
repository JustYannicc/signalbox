#!/usr/bin/env python3.11
"""Run under heavy-slot. Check/link only the WASI registration probe, two jobs."""
# pyright: reportImplicitRelativeImport=false

import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
ASSETS = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from dependencies.wasi import NIGHTLY, _environment
from toolchain import _patches as base_patches
from wasi_reactor import prepare_wasi_reactor

NAME = "wasi-registration-probe"
TARGET = "wasm32-wasip1"


def command(args, output, env, timeout=None):
    print("+ " + shlex.join(map(str, args)), flush=True)
    with (output / "build.log").open("a") as log:
        result = subprocess.run(list(map(str, args)), cwd=output, env=env, text=True,
                                stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
    if result.returncode:
        print((output / "build.log").read_text()[-16000:], flush=True)
        result.check_returncode()


def private_sysroot(installed: Path, output: Path) -> Path:
    """Keep panic-runtime placement and any build-std writes off installed Rust."""
    overlay = output / "rust-sysroot"
    lib = overlay / "lib/rustlib"
    lib.mkdir(parents=True)
    (overlay / "bin").symlink_to(installed / "bin", target_is_directory=True)
    for entry in (installed / "lib/rustlib").iterdir():
        if entry.name not in (TARGET, "src"):
            (lib / entry.name).symlink_to(entry, target_is_directory=entry.is_dir())
    # Copy patched std sources. Cargo must never write into the installed copy.
    shutil.copytree(installed / "lib/rustlib/src", lib / "src", symlinks=True)
    shutil.copytree(installed / "lib/rustlib" / TARGET, lib / TARGET, symlinks=True)
    return overlay


def place_runtime(output: Path, overlay: Path):
    lib = overlay / "lib/rustlib" / TARGET / "lib"
    for source in (output / "target" / TARGET / "debug/deps").glob("libpanic_abort-*.*"):
        if source.suffix in (".rlib", ".rmeta"):
            shutil.copyfile(source, lib / source.name)


def manifest(path: Path, name: str, patches: dict[str, Path], tokio: bool):
    path.mkdir()
    source = "probe.rs" if tokio else "mio-only.rs"
    shutil.copyfile(ASSETS / source, path / "lib.rs")
    if tokio:
        shutil.copyfile(ASSETS / "selector-cases.rs", path / "selector-cases.rs")
    dependencies = ('tokio = { version = "=1.52.3", features = ["rt", "net", "sync"] }\n'
                    if tokio else "")
    patch_entries = "\n".join(f"{json.dumps(k)} = {{ path = {json.dumps(str(v))} }}"
                              for k, v in patches.items())
    (path / "Cargo.toml").write_text(
        f'[package]\nname = "{name}"\nversion = "0.1.0"\nedition = "2021"\n'
        '[workspace]\n[lib]\npath = "lib.rs"\n'
        + ('crate-type = ["cdylib"]\n' if tokio else '')
        + '[profile.dev]\npanic = "abort"\ndebug = 0\n'
        + '[dependencies]\n' + dependencies
        + 'mio = { version = "=1.2.0", default-features = false, features = ["os-poll", "os-ext"] }\n'
        + '[patch.crates-io]\n' + patch_entries + '\n')


def prove_runtime(artifact: Path, output: Path, env, args, report):
    report["probeSha256"] = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                             for path in ASSETS.iterdir() if path.suffix in (".rs", ".mjs", ".py")}
    report["artifact"] = str(artifact)
    report["moduleSha256"] = hashlib.sha256(artifact.read_bytes()).hexdigest()
    report["moduleBytes"] = artifact.stat().st_size
    report["status"] = "linked-runtime-unverified"
    kernel_manifest = None
    kernel_files: dict[str, str] = {}
    if env.get("SIGNALBOX_KERNEL_WASI_MODULE"):
        kernel_manifest = Path(env["SIGNALBOX_KERNEL_WASI_MODULE"]).parent / "manifest.json"
        if kernel_manifest.is_file():
            evidence = json.loads(kernel_manifest.read_text())
            report["kernelManifest"] = evidence
            kernel_files = evidence["files"]
            for path, checksum in kernel_files.items():
                if hashlib.sha256((kernel_manifest.parent / path).read_bytes()).hexdigest() != checksum:
                    raise ValueError(f"kernel snapshot changed: {path}")
    command([args.node, "--experimental-wasm-jspi", ASSETS / "host-probe.mjs", artifact,
             *([args.host_adapter.resolve()] if args.host_adapter else [])], output, env, timeout=60)
    if kernel_manifest is not None and kernel_manifest.is_file():
        for path, checksum in kernel_files.items():
            if hashlib.sha256((kernel_manifest.parent / path).read_bytes()).hexdigest() != checksum:
                raise ValueError(f"kernel snapshot changed during runtime: {path}")
    if args.host_adapter:
        report["status"] = "runtime-passed"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installed-cache", type=Path, default=ROOT / ".cache")
    parser.add_argument("--base-deps", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--reuse-build", type=Path,
                        help="reuse this probe's private std/toolchain overlay and target directory")
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--runtime-only", type=Path, help="reprove an already linked probe without building")
    parser.add_argument("--host-adapter", type=Path,
                        help="parent-owned JS module exporting createProbeHost, see README.md")
    args = parser.parse_args()
    output = args.output.resolve()
    if not output.is_relative_to(ASSETS) or output == ASSETS:
        raise ValueError("probe writes must stay below wasi-reactor/")
    output.mkdir(parents=True, exist_ok=False)
    if args.runtime_only:
        report: dict[str, object] = {"scope": "minimal WASI registration runtime, not full engine"}
        try:
            prove_runtime(args.runtime_only.resolve(), output, dict(os.environ), args, report)
        except BaseException as error:
            report["status"] = "failed"
            report["error"] = str(error)
            raise
        finally:
            (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({key: report[key] for key in ("status", "moduleSha256")}))
        return
    installed_cache = args.installed_cache.resolve()
    roots = sorted(installed_cache.glob(f"wasi-toolchain-*/rustup/toolchains/{NIGHTLY}-*"))
    if len(roots) != 1:
        raise ValueError("expected one installed private Rust toolchain; probe never installs it")
    installed = roots[0]
    toolchain = installed.parents[2]
    original = args.base_deps or installed_cache / "wasi-deps-35fbfb7a9cc4d2e1"
    patches = base_patches(original)
    report = {"scope": "minimal WASI registration probe, not full engine", "status": "preparing"}
    try:
        adapted = prepare_wasi_reactor(output / "dependencies", {"sources": installed_cache / "sources"}, patches)
        report["patches"] = {name: str(path) for name, path in adapted.items()}
        report["patchSha256"] = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                                 for path in ASSETS.glob("*.patch")}
        report["probeSha256"] = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                                 for path in ASSETS.iterdir() if path.suffix in (".rs", ".mjs", ".py")}
        report["cacheIdentity"] = json.loads((adapted["tokio"].parent / ".ready").read_text())["identity"]
        build_root = args.reuse_build.resolve() if args.reuse_build else output
        if not build_root.is_relative_to(ASSETS / "out"):
            raise ValueError("reused build state must belong to this probe")
        overlay = build_root / "rust-sysroot" if args.reuse_build else private_sysroot(installed, output)
        rustc = build_root / "rustc"
        if not args.reuse_build:
            rustc.write_text("#!/bin/sh\nexec " + shlex.join([str(installed / "bin/rustc"), "--sysroot", str(overlay)])
                             + ' "$@"\n')
            rustc.chmod(0o755)
        env = dict(os.environ)
        for key in ("RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER"):
            env.pop(key, None)
        env.update(_environment(toolchain, shutil.which("rustup") or "rustup"))
        # This fixture is a reactor export, not the wrapper's command executable.
        env["CARGO_ENCODED_RUSTFLAGS"] = env["CARGO_ENCODED_RUSTFLAGS"].replace(
            "crt1-command.o", "crt1-reactor.o") + "\x1f-C\x1flink-arg=--export=_initialize"
        env.update({"RUSTC": str(rustc), "RUSTDOC": str(installed / "bin/rustdoc"),
                    "CARGO_HOME": str(build_root / "cargo-home"), "CARGO_TARGET_DIR": str(build_root / "target"),
                    "CARGO_BUILD_JOBS": "2", "CARGO_INCREMENTAL": "0", "PYTHONDONTWRITEBYTECODE": "1"})
        cargo = installed / "bin/cargo"
        flags = ["--target", TARGET, "-Z", "build-std=std,panic_abort", "--jobs", "2"]
        for name, with_tokio in [("mio-only", False), (NAME, True)]:
            crate = output / name
            # Pass only used patch entries, preserving the complete map above for review.
            needed = ("mio", "libc", "tokio") if with_tokio else ("mio", "libc")
            manifest(crate, name, {k: adapted[k] for k in needed}, with_tokio)
            report["status"] = f"check-{name}"
            command([cargo, "check", "--manifest-path", crate / "Cargo.toml", *flags], output, env)
            place_runtime(build_root, overlay)
        report["status"] = "link"
        command([cargo, "build", "--manifest-path", output / NAME / "Cargo.toml", *flags], output, env)
        built = build_root / "target" / TARGET / "debug" / (NAME.replace("-", "_") + ".wasm")
        artifact = output / "probe.wasm"
        shutil.copyfile(built, artifact)
        prove_runtime(artifact, output, env, args, report)
    except BaseException as error:
        report["failedStage"] = report["status"]
        report["status"] = "failed"
        report["error"] = str(error)
        raise
    finally:
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
