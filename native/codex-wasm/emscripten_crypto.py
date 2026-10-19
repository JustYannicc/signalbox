"""Copy Ring into the wrapper cache and enable its existing Emscripten RNG route."""

import hashlib
import json
from pathlib import Path
import tarfile
import tempfile
import tomllib

from dependencies.staging import cache_root, download, extract, locked, patch_series

ASSETS = Path(__file__).resolve().parent / "emscripten/crypto"
CRATES = {
    "ring": ("0.17.14", "a4689e6c2294d81e88dc6261c768b63bc4fcdb852be6d1352498b114f61383b7"),
}


def _patches() -> list[Path]:
    patches = [ASSETS / "ring.patch"]
    for patch in patches:
        if not patch.is_file():
            raise ValueError(f"missing Emscripten crypto patch: {patch}")
    return patches


def _identity() -> str:
    digest = hashlib.sha256(json.dumps(CRATES, sort_keys=True).encode())
    digest.update(b"emscripten-crypto-v1")
    for patch in _patches():
        digest.update(patch.name.encode())
        digest.update(patch.read_bytes())
    return digest.hexdigest()


def _inventory(root: Path) -> dict[str, str]:
    files = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"crypto adapter must not contain symlinks: {path}")
        if path.is_file() and path != root / ".ready":
            files[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return files


def _paths(root: Path) -> dict[str, Path]:
    paths = {}
    for name, (version, _) in CRATES.items():
        path = root / name
        if path.is_symlink():
            raise ValueError(f"crypto adapter must not be a symlink: {path}")
        package = tomllib.loads((path / "Cargo.toml").read_text())["package"]
        if (package["name"], package["version"]) != (name, version):
            raise ValueError(f"expected {name} {version} at {path}")
        paths[name] = path
    return paths


def prepare_emscripten_crypto(cache: Path, sources: dict[str, Path]) -> dict[str, Path]:
    """Return absolute crate-name -> path entries for wrapper [patch.crates-io].

    The original checkouts are exclusion boundaries. Only checksum-pinned crate
    copies receive patches; an incomplete stage is discarded and a completed
    stage must match its identity and file inventory before reuse.
    """
    cache = cache_root(cache, sources)
    with locked(cache):
        identity = _identity()
        root = cache / f"emscripten-crypto-{identity[:16]}"
        if root.is_symlink() or any(source.resolve().is_relative_to(root) for source in sources.values()):
            raise ValueError(f"crypto adapter must not contain or redirect to sources: {root}")
        if root.exists():
            files = _inventory(root)
            paths = _paths(root)
            ready = json.loads((root / ".ready").read_text())
            if ready != {"identity": identity, "files": files}:
                raise ValueError(f"Emscripten crypto cache changed: {root}")
            return paths
        with tempfile.TemporaryDirectory(prefix=".emscripten-crypto-", dir=cache) as temporary:
            stage = Path(temporary)
            for name, (version, checksum) in CRATES.items():
                filename = f"{name}-{version}.crate"
                archive = download(f"https://static.crates.io/crates/{name}/{filename}",
                                   cache / "downloads" / filename, checksum)
                with tarfile.open(archive, "r:gz") as contents:
                    extract(contents, stage)
                (stage / f"{name}-{version}").rename(stage / name)
            _inventory(stage)
            _paths(stage)
            patch_series(stage, _patches())
            _paths(stage)
            (stage / ".ready").write_text(json.dumps({"identity": identity, "files": _inventory(stage)},
                                                   sort_keys=True))
            stage.rename(root)
        return _paths(root)
