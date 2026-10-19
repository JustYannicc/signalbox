"""Stage released url with the WASI encoder fix from servo/rust-url#1158.

Backport of 51708bea2ec5ffa710a3914a9a9623875748fedd onto url 2.5.8.
Invalid UTF-8 encoding returns Err, allowing Codex's existing OPAQUE fallback.
Ordinary percent-encoded invalid UTF-8 file URI decoding remains unsupported.
"""

import hashlib
import json
from pathlib import Path
import tarfile
import tempfile
import tomllib

from .staging import cache_root, download, extract, locked, patch_series

ASSETS = Path(__file__).resolve().parent / "patches"
CRATES = {
    "url": ("2.5.8", "ff67a8a4397373c3ef660812acab3268222035010ab8680ec4215f38ba3d0eed"),
}


def _patches() -> list[Path]:
    patch = ASSETS / "url.patch"
    if patch.is_symlink() or not patch.is_file():
        raise ValueError(f"missing or symlinked URL patch: {patch}")
    return [patch]


def _identity() -> str:
    digest = hashlib.sha256(json.dumps(CRATES, sort_keys=True).encode())
    digest.update(b"url-stage-v1")
    for patch in _patches():
        digest.update(patch.name.encode())
        digest.update(patch.read_bytes())
    return digest.hexdigest()


def _guard(path: Path, sources: dict[str, Path]):
    if path.is_symlink():
        raise ValueError(f"URL cache must not contain symlinks: {path}")
    resolved = path.resolve()
    for source in sources.values():
        source = source.resolve()
        if resolved.is_relative_to(source) or source.is_relative_to(resolved):
            raise ValueError(f"URL cache path overlaps a source checkout: {path}")


def _inventory(root: Path) -> dict[str, str]:
    files = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"URL stage must not contain symlinks: {path}")
        if path.is_file():
            if path != root / ".ready":
                files[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
        elif not path.is_dir():
            raise ValueError(f"unsupported URL stage entry: {path}")
    return files


def _paths(root: Path) -> dict[str, Path]:
    paths = {}
    for name, (version, _) in CRATES.items():
        path = root / name
        package = tomllib.loads((path / "Cargo.toml").read_text())["package"]
        if (package["name"], package["version"]) != (name, version):
            raise ValueError(f"expected {name} {version} at {path}")
        paths[name] = path
    return paths


def prepare_url_dependency(cache: Path, sources: dict[str, Path]) -> dict[str, Path]:
    """Return absolute crate paths for wrapper [patch.crates-io], without Cargo.

    Only cache-owned archive copies receive patches. Completed stages must match
    their identity and file inventory; older stages and source trees stay intact.
    """
    identity = _identity()
    root = cache.resolve() / f"url-{identity[:16]}"
    downloads = cache.resolve() / "downloads"
    lock = cache.resolve() / ".prepare.lock"
    for path in (root, downloads, lock):
        _guard(path, sources)
    cache = cache_root(cache, sources)
    with locked(cache):
        if root.exists():
            files = _inventory(root)
            paths = _paths(root)
            ready = json.loads((root / ".ready").read_text())
            if ready != {"identity": identity, "files": files}:
                raise ValueError(f"URL cache changed: {root}")
            return paths
        with tempfile.TemporaryDirectory(prefix=".url-", dir=cache) as temporary:
            stage = Path(temporary)
            for name, (version, checksum) in CRATES.items():
                filename = f"{name}-{version}.crate"
                archive = downloads / filename
                for path in (archive, archive.with_suffix(".crate.partial")):
                    _guard(path, sources)
                archive = download(f"https://static.crates.io/crates/{name}/{filename}",
                                   archive, checksum)
                with tarfile.open(archive, "r:gz") as contents:
                    extract(contents, stage)
                (stage / f"{name}-{version}").rename(stage / name)
            _inventory(stage)
            _paths(stage)
            library = stage / "url/src/lib.rs"
            original = library.read_bytes()
            patch_series(stage, _patches())
            # Apple's patch keeps a pristine backup even for an exact application.
            backup = library.with_suffix(".rs.orig")
            if backup.exists():
                if backup.is_symlink() or backup.read_bytes() != original:
                    raise ValueError(f"unexpected URL patch backup: {backup}")
                backup.unlink()
            _paths(stage)
            (stage / ".ready").write_text(json.dumps({"identity": identity, "files": _inventory(stage)},
                                                   sort_keys=True))
            stage.rename(root)
        return _paths(root)
