"""Cache-owned Tokio/Mio adapter for wasm32-unknown-emscripten.

Preparation does not install a toolchain or change Codex. The patch map fits
workspace.prepare_workspace. These crates require the host reactor described
in emscripten/patches/README.md; compiling them does not prove host support.
"""

import hashlib
import json
from pathlib import Path
import tarfile
import tempfile
import tomllib

from dependencies.staging import cache_root, download, extract, locked, patch_series

ASSETS = Path(__file__).resolve().parent / "emscripten/patches"
# Release lock checksums, also published by crates.io's version API.
CRATES = {
    "tokio": ("1.52.3", "8fc7f01b389ac15039e4dc9531aa973a135d7a4135281b12d7c1bc79fd57fffe"),
    "mio": ("1.2.0", "50b7e5b27aa02a74bac8c3f23f448f8d87ff11f92d3aac1a6ed369ee08cc56c1"),
    "socket2": ("0.6.5", "c3d1e2c7f27f8d4cb10542a02c49005dbd6e93095799d6f3be745fae9f8fedd4"),
    "tokio-util": ("0.7.18", "9ae9cec805b01e8fc3fd2fe289f89149a9b66dd16786abd8b19cfa7b48cb0098"),
    "socket2_05": ("0.5.10", "e22376abed350d73dd1cd119b57ffccad95b4e585a7cda43e286245ce23c0678"),
    "nix": ("0.28.0", "ab2156c4fce2f8df6c499cc1c763e4394b7482525bf2a9701c9d79d215f519e4"),
    "serial2": ("0.2.33", "8cc76fa68e25e771492ca1e3c53d447ef0be3093e05cd3b47f4b712ba10c6f3c"),
    "nix_031": ("0.31.3", "cf20d2fde8ff38632c426f1165ed7436270b44f199fc55284c38276f9db47c3d"),
    "opentelemetry-otlp": ("0.31.0", "7a2366db2dca4d2ad033cad11e6ee42844fd727007af5ad04a1730f4cb8163bf"),
}
PACKAGE_NAMES = {"socket2_05": "socket2", "nix_031": "nix"}


def _identity() -> str:
    digest = hashlib.sha256(json.dumps(CRATES, sort_keys=True).encode())
    digest.update(json.dumps(PACKAGE_NAMES, sort_keys=True).encode())
    digest.update(b"emscripten-deps-v1")
    for patch in _patches():
        digest.update(patch.name.encode())
        digest.update(patch.read_bytes())
    return digest.hexdigest()


def _patches() -> list[Path]:
    patches = [ASSETS / f"{name}.patch" for name in ("mio", "tokio", "tokio-util", "socket2_05", "nix", "serial2", "opentelemetry-otlp", "nix_031")]
    for patch in patches:
        if not patch.is_file():
            raise ValueError(f"missing Emscripten dependency patch: {patch}")
    return patches


def _inventory(root: Path) -> dict[str, str]:
    files = {}
    for name in CRATES:
        for path in sorted((root / name).rglob("*")):
            if path.is_symlink():
                raise ValueError(f"dependency adapter must not contain symlinks: {path}")
            if path.is_file():
                files[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return files


def _paths(root: Path) -> dict[str, Path]:
    paths = {}
    for name, (version, _) in CRATES.items():
        path = root / name
        if path.is_symlink():
            raise ValueError(f"dependency adapter must not be a symlink: {path}")
        package = tomllib.loads((path / "Cargo.toml").read_text())["package"]
        package_name = PACKAGE_NAMES.get(name, name)
        if (package["name"], package["version"]) != (package_name, version):
            raise ValueError(f"expected {package_name} {version} at {path}")
        paths[name] = path
    return paths


def prepare_emscripten_dependencies(cache: Path, sources: dict[str, Path]) -> dict[str, Path]:
    """Return absolute patch-alias -> path entries for wrapper [patch.crates-io].

    Sources are exclusion boundaries, never modified or used as mutable crates.
    Pinned crate archives are copied into an atomic stage before applying our
    target-specific patches. Native and WASI cfg branches retain their behavior.
    A completed stage is checked for accidental changes before it is reused.
    """
    cache = cache_root(cache, sources)
    with locked(cache):
        identity = _identity()
        root = cache / f"emscripten-deps-{identity[:16]}"
        if root.is_symlink() or any(source.resolve().is_relative_to(root) for source in sources.values()):
            raise ValueError(f"dependency adapter must not contain or redirect to sources: {root}")
        if root.exists():
            paths = _paths(root)
            ready = json.loads((root / ".ready").read_text())
            if ready != {"identity": identity, "files": _inventory(root)}:
                raise ValueError(f"Emscripten dependency cache changed: {root}")
            return paths
        with tempfile.TemporaryDirectory(prefix=".emscripten-deps-", dir=cache) as temporary:
            stage = Path(temporary)
            for name, (version, checksum) in CRATES.items():
                package_name = PACKAGE_NAMES.get(name, name)
                filename = f"{package_name}-{version}.crate"
                archive = download(f"https://static.crates.io/crates/{package_name}/{filename}",
                                   cache / "downloads" / filename, checksum)
                with tarfile.open(archive, "r:gz") as contents:
                    extract(contents, stage)
                (stage / f"{package_name}-{version}").rename(stage / name)
            patch_series(stage, _patches())
            _paths(stage)
            (stage / ".ready").write_text(json.dumps({"identity": identity, "files": _inventory(stage)},
                                                   sort_keys=True))
            stage.rename(root)
        return _paths(root)
