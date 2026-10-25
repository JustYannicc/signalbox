"""Cache-owned WASI preparation for the wrapper's workspace root.

Both functions may download sources. Toolchain preparation also installs Rust
inside the cache and builds libc, so callers must acquire the heavy-build slot.
"""

import hashlib
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import tomllib

from dependencies.staging import (
    AGENTOS, ASSETS, CRATES, DIGIBUGCAT, RIVET_CODEX,
    cache_root, download, extract, git_archive, locked, patch_series,
)
from dependencies.wasi import prepare as prepare_toolchain

_STUBS = ["reqwest-shim", "portable-pty-wasi", "ctrlc"]
_LIBS = ["wasi-http", "wasi-spawn", "wasi-pty"]


def _identity() -> str:
    digest = hashlib.sha256(json.dumps([AGENTOS, RIVET_CODEX, DIGIBUGCAT, CRATES]).encode())
    digest.update((ASSETS / "patches/wasi-deps.patch").read_bytes())
    return digest.hexdigest()


def _patches(root: Path) -> dict[str, Path]:
    paths = {"tokio": root / "tokio"}
    paths.update({name: root / "stubs" / directory for name, directory in
                  [("reqwest", "reqwest-shim"), ("portable-pty", "portable-pty-wasi"), ("ctrlc", "ctrlc")]})
    paths.update({name: root / "patched" / f"{name}-{version}" for name, (version, _) in CRATES.items()})
    for name, path in paths.items():
        package = tomllib.loads((path / "Cargo.toml").read_text())["package"]
        if package["name"] != name:
            raise ValueError(f"expected crate {name} at {path}")
    return paths


def prepare_dependencies(cache: Path, sources: dict[str, Path]) -> dict[str, Path]:
    """Return absolute crate-name -> path entries for wrapper [patch.crates-io].

    sources keys: agentos, rivet-codex, codex-wasi-agentos. Git archives read the
    pinned commits, including in no-checkout repositories. Cargo caches are unused.
    A failed stage is discarded; completed stages are reused without downloads.
    """
    cache = cache_root(cache, sources)
    with locked(cache):
        identity = _identity()
        root = cache / f"wasi-deps-{identity[:16]}"
        if root.is_symlink():
            raise ValueError(f"dependency cache must not be a symlink: {root}")
        if (root / ".ready").is_file():
            if (root / ".ready").read_text() != identity:
                raise ValueError(f"dependency cache identity mismatch: {root}")
            return _patches(root)
        with tempfile.TemporaryDirectory(prefix=".wasi-deps-", dir=cache) as temporary:
            stage = Path(temporary)
            git_archive(sources["rivet-codex"], RIVET_CODEX, ["codex-rs/vendor/tokio-wasi"], stage)
            (stage / "codex-rs/vendor/tokio-wasi").rename(stage / "tokio")
            shutil.rmtree(stage / "codex-rs")
            paths = ([f"toolchain/stubs/{name}" for name in _STUBS]
                     + [f"toolchain/crates/libs/{name}" for name in _LIBS]
                     + ["toolchain/crates/wasi-ext"])
            git_archive(sources["agentos"], AGENTOS, paths, stage)
            (stage / "toolchain/stubs").rename(stage / "stubs")
            (stage / "toolchain/crates").rename(stage / "crates")
            (stage / "toolchain").rmdir()
            for name, (version, checksum) in CRATES.items():
                filename = f"{name}-{version}.crate"
                archive = download(f"https://static.crates.io/crates/{name}/{filename}",
                                   cache / "downloads" / filename, checksum)
                with tarfile.open(archive, "r:gz") as contents:
                    extract(contents, stage / "patched")
                for marker in [".cargo-ok", ".cargo_vcs_info.json"]:
                    (stage / "patched" / f"{name}-{version}" / marker).unlink(missing_ok=True)
            patch_series(stage, [ASSETS / "patches/wasi-deps.patch"])
            _patches(stage)
            (stage / ".ready").write_text(identity)
            stage.rename(root)
        return _patches(root)


def prepare_wasi_toolchain(cache: Path, sources: dict[str, Path]) -> dict[str, str]:
    """Return environment overrides; use returned CARGO as the cargo executable.

    The executable takes normal Cargo arguments and supplies nightly selection.
    It handles the reference build's panic_abort placement with one bounded retry
    only for a missing-panic_abort diagnostic and changed runtime placement. Call it with
    build --target wasm32-wasip1 -Z build-std=std,panic_abort and a cache-owned
    CARGO_TARGET_DIR. All Rust/Cargo homes and patched sources remain in cache.
    """
    cache = cache_root(cache, sources)
    with locked(cache):
        return prepare_toolchain(cache, sources)
