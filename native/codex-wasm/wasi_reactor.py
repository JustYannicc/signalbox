"""Isolated WASI preview1 registration adapter over the existing Tokio reactor."""

import hashlib
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import tomllib

from dependencies.staging import cache_root, download, extract, locked, patch_series

ASSETS = Path(__file__).resolve().parent / "wasi-reactor"
MIO = ("1.2.0", "50b7e5b27aa02a74bac8c3f23f448f8d87ff11f92d3aac1a6ed369ee08cc56c1")
TOKIO_VERSION = "1.52.3"


def _inventory(root: Path) -> dict[str, str]:
    if root.is_symlink() or not root.is_dir():
        raise ValueError(f"reactor input/output must be a directory, not a symlink: {root}")
    files = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"reactor crate must not contain symlinks: {path}")
        if path.is_file():
            files[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
        elif not path.is_dir():
            raise ValueError(f"unsupported reactor crate entry: {path}")
    return files


def _package(path: Path, name: str, version: str):
    if path.is_symlink():
        raise ValueError(f"reactor crate must not be a symlink: {path}")
    package = tomllib.loads((path / "Cargo.toml").read_text())["package"]
    if (package["name"], package["version"]) != (name, version):
        raise ValueError(f"expected {name} {version} at {path}")


def _patches() -> list[Path]:
    paths = [ASSETS / f"{name}.patch" for name in ("mio", "tokio")]
    for path in paths:
        if not path.is_file():
            raise ValueError(f"missing WASI reactor patch: {path}")
    return paths


def _identity(input_files: dict[str, str]) -> str:
    digest = hashlib.sha256(json.dumps(["wasi-reactor-v1", MIO, TOKIO_VERSION, input_files],
                                      sort_keys=True).encode())
    for path in _patches():
        digest.update(path.name.encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def _paths(root: Path) -> dict[str, Path]:
    for name, version in [("tokio", TOKIO_VERSION), ("mio", MIO[0])]:
        _package(root / name, name, version)
    return {name: root / name for name in ("tokio", "mio")}


def _ready(root: Path, identity: str) -> dict[str, object]:
    return {"identity": identity, "files": {name: _inventory(path)
                                          for name, path in _paths(root).items()}}


def prepare_wasi_reactor(cache: Path, source_boundaries: dict[str, Path],
                         base_patches: dict[str, Path]) -> dict[str, Path]:
    """Return a new complete patch map, replacing only Tokio and Mio.

    Tokio must be the already agentOS-patched 1.52.3 from prepare_dependencies.
    Its full contents identify a copied input; pristine Mio is checksum pinned.
    All other base entries retain their original values. No base crate or source
    is changed. Native and Emscripten cfg paths retain their existing behavior.
    Callers must use a separate cache outside every input/source directory.
    This only adds registration APIs. The host still owns nonblocking fds and
    JSPI suspension at WASI poll_oneoff, never at AsyncFd's task poll methods.
    """
    boundaries = {**{f"source:{k}": v for k, v in source_boundaries.items()},
                  **{f"base:{k}": v for k, v in base_patches.items()}}
    cache = cache_root(cache, boundaries)
    tokio = base_patches["tokio"]
    _package(tokio, "tokio", TOKIO_VERSION)
    with locked(cache):
        input_files = _inventory(tokio)
        identity = _identity(input_files)
        root = cache / f"wasi-reactor-{identity[:16]}"
        if root.is_symlink() or any(p.resolve().is_relative_to(root) for p in boundaries.values()):
            raise ValueError(f"reactor cache must not contain or redirect to inputs: {root}")
        if root.exists():
            ready = json.loads((root / ".ready").read_text())
            if ready != _ready(root, identity):
                raise ValueError(f"WASI reactor cache changed: {root}")
            return {**base_patches, **_paths(root)}
        with tempfile.TemporaryDirectory(prefix=".wasi-reactor-", dir=cache) as temporary:
            stage = Path(temporary)
            shutil.copytree(tokio, stage / "tokio", symlinks=True)
            if _inventory(stage / "tokio") != input_files or _inventory(tokio) != input_files:
                raise ValueError("Tokio input changed during reactor preparation")
            version, checksum = MIO
            filename = f"mio-{version}.crate"
            archive = download(f"https://static.crates.io/crates/mio/{filename}",
                               cache / "downloads" / filename, checksum)
            with tarfile.open(archive, "r:gz") as contents:
                extract(contents, stage)
            (stage / f"mio-{version}").rename(stage / "mio")
            patch_series(stage, _patches())
            (stage / ".ready").write_text(json.dumps(_ready(stage, identity), sort_keys=True))
            stage.rename(root)
        return {**base_patches, **_paths(root)}
