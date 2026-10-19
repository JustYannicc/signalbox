"""Stage the wrapper-owned cooperative WASI worker for SQLx's SQLite driver."""

import hashlib
import json
from pathlib import Path
import re
import shutil
import tarfile
import tempfile
import tomllib

from dependencies.staging import cache_root, download, extract, locked, patch_series

ASSETS = Path(__file__).resolve().parent / "sqlite"
SQLX_SQLITE = ("0.9.0", "488e99c397a62007e4229aec669a179816339afc6d2620ca6fa420dbee2e982c")
TOKIO_VERSION = "1.52.3"
_WASI_CFG = 'all(target_os = "wasi", target_env = "p1", not(target_feature = "atomics"))'
_TARGET = f"cfg({_WASI_CFG})"
_PATCH_PATHS = {
    "sqlx-sqlite/Cargo.toml",
    "sqlx-sqlite/src/connection/mod.rs",
}
_EXPECTED_FILES = {
    "Cargo.toml",
    "src/connection/mod.rs",
    "src/connection/worker_wasi.rs",
}


def _assets() -> tuple[Path, Path]:
    module = ASSETS / "worker_wasi.rs"
    patch = ASSETS / "sqlx-worker.patch"
    for path in (module, patch):
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"missing or symlinked SQLx SQLite patch input: {path}")
    patch_paths = {
        line[6:]
        for line in patch.read_text().splitlines()
        if line.startswith(("--- a/", "+++ b/"))
    }
    if patch_paths != _PATCH_PATHS:
        raise ValueError(f"SQLx worker patch has unexpected file scope: {sorted(patch_paths)}")
    module_source = module.read_text()
    if "Derived from SQLx 0.9.0" not in module_source:
        raise ValueError("SQLx WASI worker is missing its upstream source attribution")
    if re.search(r"tokio = \{ version = \"=1\.52\.3\", default-features = false, features = \[\"rt\"\] \}",
                 patch.read_text()) is None:
        raise ValueError("SQLx worker patch is missing the exact Tokio runtime dependency")
    return module, patch


def _identity() -> str:
    digest = hashlib.sha256(json.dumps(
        ["sqlite-worker-v1", SQLX_SQLITE, TOKIO_VERSION], sort_keys=True,
    ).encode())
    for path in _assets():
        digest.update(path.name.encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def _guard(path: Path, boundaries: dict[str, Path]) -> None:
    if path.is_symlink():
        raise ValueError(f"SQLx SQLite cache paths must not be symlinks: {path}")
    resolved = path.resolve()
    for name, boundary in boundaries.items():
        boundary = boundary.resolve()
        if resolved.is_relative_to(boundary) or boundary.is_relative_to(resolved):
            raise ValueError(f"SQLx SQLite cache overlaps {name}: {path}")


def _inventory(root: Path) -> dict[str, str]:
    if root.is_symlink() or not root.is_dir():
        raise ValueError(f"SQLx SQLite stage must be a directory, not a symlink: {root}")
    files = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"SQLx SQLite stage must not contain symlinks: {path}")
        if path.is_file():
            if path != root / ".ready":
                files[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
        elif not path.is_dir():
            raise ValueError(f"unsupported SQLx SQLite stage entry: {path}")
    return files


def _package(path: Path, name: str, version: str) -> None:
    if path.is_symlink() or not path.is_dir():
        raise ValueError(f"SQLx SQLite package must be a directory, not a symlink: {path}")
    package = tomllib.loads((path / "Cargo.toml").read_text())["package"]
    if (package["name"], package["version"]) != (name, version):
        raise ValueError(f"expected {name} {version} at {path}")


def _paths(root: Path) -> dict[str, Path]:
    path = root / "sqlx-sqlite"
    _package(path, "sqlx-sqlite", SQLX_SQLITE[0])
    manifest = tomllib.loads((path / "Cargo.toml").read_text())
    dependencies = manifest.get("target", {}).get(_TARGET, {}).get("dependencies", {})
    tokio = dependencies.get("tokio", {})
    if tokio.get("version") != f"={TOKIO_VERSION}" or tokio.get("default-features") is not False:
        raise ValueError(f"SQLx WASI worker must use its pinned Tokio runtime dependency at {path}")
    if set(tokio.get("features", [])) != {"rt"}:
        raise ValueError(f"unexpected Tokio features for SQLx WASI worker at {path}")
    connection = (path / "src/connection/mod.rs").read_text()
    if (f'#[cfg({_WASI_CFG})]\n#[path = "worker_wasi.rs"]\nmod worker;\n'
            f'#[cfg(not({_WASI_CFG}))]\n'
            'mod worker;\n') not in connection:
        raise ValueError(f"SQLx connection module does not select the target-specific worker: {path}")
    module, _ = _assets()
    if (path / "src/connection/worker_wasi.rs").read_bytes() != module.read_bytes():
        raise ValueError(f"staged SQLx worker differs from its reviewed source: {path}")
    return {"sqlx-sqlite": path}


def _ready(root: Path, identity: str) -> dict[str, object]:
    return {
        "identity": identity,
        "crate": {"name": "sqlx-sqlite", "version": SQLX_SQLITE[0], "sha256": SQLX_SQLITE[1]},
        "files": _inventory(root),
    }


def prepare_sqlite_dependencies(
    cache: Path,
    source_boundaries: dict[str, Path],
    base_patches: dict[str, Path],
) -> dict[str, Path]:
    """Return a full crate-name map with only SQLx SQLite staged and replaced.

    The released SQLx crate archive is checksum-pinned. Patches land in a private
    copy under ``cache``; source checkouts, registry crates, and existing patched
    dependencies remain immutable inputs. The target-specific Tokio dependency
    resolves through the caller's existing ``base_patches["tokio"]`` entry.
    """
    if "tokio" not in base_patches:
        raise ValueError("SQLx WASI worker staging requires the existing Tokio patch")
    _package(base_patches["tokio"], "tokio", TOKIO_VERSION)
    module, patch = _assets()
    boundaries = {
        **{f"source:{name}": path for name, path in source_boundaries.items()},
        **{f"base:{name}": path for name, path in base_patches.items()},
    }
    requested_cache = Path(cache).absolute()
    if requested_cache.is_symlink():
        raise ValueError(f"SQLx SQLite cache must not be a symlink: {requested_cache}")
    for name, boundary in boundaries.items():
        boundary = boundary.resolve()
        resolved = requested_cache.resolve()
        if resolved.is_relative_to(boundary) or boundary.is_relative_to(resolved):
            raise ValueError(f"SQLx SQLite cache overlaps {name}: {requested_cache}")

    cache = cache_root(requested_cache, source_boundaries)
    identity = _identity()
    root = cache / f"sqlite-sqlx-{identity[:16]}"
    downloads = cache / "downloads"
    archive_path = downloads / f"sqlx-sqlite-{SQLX_SQLITE[0]}.crate"
    for path in (root, downloads, archive_path, cache / ".prepare.lock"):
        _guard(path, boundaries)

    with locked(cache):
        if root.exists():
            if root.is_symlink():
                raise ValueError(f"SQLx SQLite cache must not be a symlink: {root}")
            try:
                marker = root / ".ready"
                if marker.is_symlink() or not marker.is_file():
                    raise ValueError(f"SQLx SQLite cache has no regular ready marker: {root}")
                ready = json.loads(marker.read_text())
            except (OSError, json.JSONDecodeError) as error:
                raise ValueError(f"SQLx SQLite cache is incomplete: {root}") from error
            if ready != _ready(root, identity):
                raise ValueError(f"SQLx SQLite cache changed: {root}")
            paths = _paths(root)
            return {**base_patches, **paths}

        archive = download(
            f"https://static.crates.io/crates/sqlx-sqlite/sqlx-sqlite-{SQLX_SQLITE[0]}.crate",
            archive_path,
            SQLX_SQLITE[1],
        )
        with tempfile.TemporaryDirectory(prefix=".sqlite-sqlx-", dir=cache) as temporary:
            stage = Path(temporary)
            with tarfile.open(archive, "r:gz") as contents:
                extract(contents, stage)
            original = stage / f"sqlx-sqlite-{SQLX_SQLITE[0]}"
            _package(original, "sqlx-sqlite", SQLX_SQLITE[0])
            original.rename(stage / "sqlx-sqlite")
            before = _inventory(stage / "sqlx-sqlite")
            patch_series(stage, [patch])
            staged_sqlite = stage / "sqlx-sqlite"
            _inventory(staged_sqlite)
            worker_path = staged_sqlite / "src/connection/worker_wasi.rs"
            if worker_path.exists():
                raise ValueError("pinned SQLx source unexpectedly contains the wrapper WASI worker path")
            shutil.copyfile(module, worker_path)
            files = _inventory(staged_sqlite)
            changed = {
                name for name in before.keys() | files.keys()
                if before.get(name) != files.get(name)
            }
            if changed != _EXPECTED_FILES:
                raise ValueError(f"unexpected SQLx SQLite patch scope: {sorted(changed)}")
            if (staged_sqlite / "src/connection/worker_wasi.rs").read_bytes() != module.read_bytes():
                raise ValueError("staged SQLx WASI worker differs from the reviewed source")
            _paths(stage)
            (stage / ".ready").write_text(json.dumps(_ready(stage, identity), sort_keys=True))
            stage.rename(root)

        return {**base_patches, **_paths(root)}
