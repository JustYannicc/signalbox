#!/usr/bin/env python3.11
# pyright: reportImplicitRelativeImport=false
"""Build a small SQLx SQLite WASI command; the parent owns isolate execution."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

WRAPPER = Path(__file__).resolve().parents[1]
TARGET = "wasm32-wasip1"
sys.path.insert(0, str(WRAPPER))

from dependencies.wasi import NIGHTLY, _environment, _identity as wasi_identity, _rust_identity
from sqlite import SQLX_SQLITE, prepare_sqlite_dependencies
from toolchain import _identity as dependencies_identity, _patches

PROBE = Path(__file__).resolve().parent / "probe.rs"


def _ready_root(cache: Path, name: str, identity: str) -> Path:
    root = cache / f"{name}-{identity[:16]}"
    if root.is_symlink() or not root.is_dir():
        raise ValueError(f"required private wrapper cache is missing: {root}")
    marker = root / ".ready"
    if marker.is_symlink() or not marker.is_file() or marker.read_text() != identity:
        raise ValueError(f"private wrapper cache is not verified: {root}")
    return root


def _toolchain(cache: Path) -> tuple[Path, dict[str, str]]:
    candidates = [
        candidate for candidate in cache.glob("wasi-toolchain-*")
        if not candidate.is_symlink()
        and (candidate / ".rust-ready").is_file()
        and (candidate / ".rust-ready").read_text() == _rust_identity()
        and (candidate / ".ready").is_file()
        and (candidate / ".ready").read_text() == wasi_identity()
    ]
    if len(candidates) != 1:
        raise ValueError("expected one verified private WASI toolchain; probe never installs it")
    root = candidates[0]
    rust_marker = root / ".rust-ready"
    sysroot_marker = root / "rust-sysroot"
    if (rust_marker.is_symlink() or not rust_marker.is_file()
            or rust_marker.read_text() != _rust_identity()):
        raise ValueError(f"private Rust toolchain is not verified: {root}")
    if sysroot_marker.is_symlink() or not sysroot_marker.is_file():
        raise ValueError(f"private Rust sysroot is missing: {root}")
    sysroot = Path(sysroot_marker.read_text()).resolve()
    if not sysroot.is_relative_to((root / "rustup").resolve()):
        raise ValueError(f"Rust sysroot escaped the private wrapper cache: {sysroot}")
    rustup = shutil.which("rustup")
    if rustup is None:
        raise RuntimeError("rustup executable is required to use the existing private toolchain")
    environment = {**os.environ, **_environment(root, rustup)}
    for key in ("RUSTFLAGS", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER"):
        environment.pop(key, None)
    environment["RUSTC"] = str(sysroot / "bin/rustc")
    environment["RUSTDOC"] = str(sysroot / "bin/rustdoc")
    environment["SIGNALBOX_WASI_RUST_SYSROOT"] = str(sysroot)
    if environment.get("RUSTUP_TOOLCHAIN") != NIGHTLY:
        raise ValueError("private wrapper toolchain does not match the WASI target pin")
    if not Path(environment["CARGO"]).is_file():
        raise ValueError("private wrapper Cargo launcher is missing")
    if not Path(environment["RUSTC"]).is_file():
        raise ValueError("private wrapper rustc is missing")
    return root, environment


def _write_probe(crate: Path, patches: dict[str, Path]) -> None:
    crate.mkdir()
    shutil.copyfile(PROBE, crate / "main.rs")
    patch_entries = "\n".join(
        f"{json.dumps(name)} = {{ path = {json.dumps(str(path.resolve()))} }}"
        for name, path in sorted(patches.items())
    )
    (crate / "Cargo.toml").write_text(
        '[package]\n'
        'name = "sqlite-worker-probe"\n'
        'version = "0.1.0"\n'
        'edition = "2024"\n'
        'publish = false\n'
        '\n[workspace]\n'
        '\n[[bin]]\nname = "sqlite-worker-probe"\npath = "main.rs"\n'
        '\n[dependencies]\n'
        'futures-util = { version = "=0.3.34", default-features = false, features = ["alloc", "std"] }\n'
        'sqlx = { version = "=0.9.0", default-features = false, features = ["sqlite-bundled", "runtime-tokio", "chrono", "json", "migrate", "time", "uuid"] }\n'
        'sqlx-sqlite = { version = "=0.9.0", features = ["offline"] }\n'
        'tokio = { version = "=1.52.3", default-features = false, features = ["macros", "rt"] }\n'
        '\n[profile.release]\n'
        'debug = 0\n'
        'panic = "abort"\n'
        '\n[patch.crates-io]\n'
        + patch_entries + '\n'
    )


def _run(args: list[str], output: Path, environment: dict[str, str]) -> None:
    print("+ " + shlex.join(args), flush=True)
    with (output / "build.log").open("a") as log:
        result = subprocess.run(args, cwd=output / "crate", env=environment,
                                text=True, stdout=log, stderr=subprocess.STDOUT)
    if result.returncode:
        print((output / "build.log").read_text()[-16000:], flush=True)
        result.check_returncode()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=WRAPPER / ".cache")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--lockfile", type=Path, required=True, help="Pinned official release Cargo.lock")
    args = parser.parse_args()

    if args.output.is_symlink():
        raise ValueError("probe output must not be a symlink")
    output = args.output.resolve()
    for boundary in (WRAPPER, args.cache.resolve(), args.lockfile.resolve()):
        if output.is_relative_to(boundary) or boundary.is_relative_to(output):
            raise ValueError(f"probe output overlaps an input: {boundary}")
    output.mkdir(parents=True, exist_ok=False)

    cache = args.cache.resolve()
    dependencies = _ready_root(cache, "wasi-deps", dependencies_identity())
    base_patches = _patches(dependencies)
    toolchain, environment = _toolchain(cache)
    staged = prepare_sqlite_dependencies(
        output / "sqlite-dependencies",
        {"wrapper": WRAPPER, "sources": cache / "sources"},
        base_patches,
    )
    _write_probe(output / "crate", staged)
    shutil.copyfile(args.lockfile, output / "crate" / "Cargo.lock")
    environment.update({
        "CARGO_TARGET_DIR": str(output / "target"),
        "CARGO_BUILD_JOBS": "2",
        "CARGO_INCREMENTAL": "0",
        "CARGO_PROFILE_RELEASE_PANIC": "abort",
    })

    command = [
        environment["CARGO"],
        "build",
        "--manifest-path",
        str(output / "crate" / "Cargo.toml"),
        "--release",
        "--target",
        TARGET,
        "-Z",
        "build-std=std,panic_abort",
        "--jobs",
        "2",
        "--offline",
    ]
    report: dict[str, object] = {
        "scope": "bundled SQLx SQLite worker command probe; not full Codex",
        "status": "building",
        "target": TARGET,
        "upstream": {"crate": "sqlx-sqlite", "version": SQLX_SQLITE[0], "sha256": SQLX_SQLITE[1]},
        "toolchain": str(toolchain),
        "cargoTargetDir": str(output / "target"),
        "patches": {name: str(path) for name, path in sorted(staged.items())},
        "inputSha256": {
            "worker_wasi.rs": hashlib.sha256((PROBE.parent / "worker_wasi.rs").read_bytes()).hexdigest()
            if (PROBE.parent / "worker_wasi.rs").is_file() else None,
            "probe.rs": hashlib.sha256(PROBE.read_bytes()).hexdigest(),
        },
        "releaseLockSha256": hashlib.sha256(args.lockfile.read_bytes()).hexdigest(),
        "command": command,
    }
    try:
        _run(command, output, environment)
        built = output / "target" / TARGET / "release" / "sqlite-worker-probe.wasm"
        if not built.is_file():
            raise ValueError(f"Cargo succeeded without producing {built.name}")
        artifact = output / "probe.wasm"
        shutil.copyfile(built, artifact)
        report.update({
            "status": "built_not_run",
            "artifact": str(artifact),
            "artifactBytes": artifact.stat().st_size,
            "artifactSha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
        })
    except BaseException as error:
        report["status"] = "failed"
        report["error"] = str(error)
        raise
    finally:
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")

    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
