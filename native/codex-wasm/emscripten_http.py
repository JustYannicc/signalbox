"""Stage the pinned AgentOS reqwest compile carrier for Emscripten."""

import hashlib
import json
from pathlib import Path
import tempfile
import tomllib

from dependencies.staging import AGENTOS, cache_root, git_archive, locked, patch_series

ASSETS = Path(__file__).resolve().parent / "emscripten/http"
DIRECTORIES = {
    "reqwest": ("toolchain/stubs/reqwest-shim", "0.12.28"),
    "agentos-wasi-http": ("toolchain/crates/libs/wasi-http", "0.0.0"),
    "wasi-ext": ("toolchain/crates/wasi-ext", "0.0.0"),
}
HOST_IMPORTS = (
    "net_close", "net_connect", "net_recv", "net_send", "net_setsockopt",
    "net_socket", "net_tls_connect",
)


def _identity() -> str:
    digest = hashlib.sha256(json.dumps([AGENTOS, DIRECTORIES], sort_keys=True).encode())
    digest.update(b"emscripten-http-v1")
    for name in ("reuse.patch", "imports.js"):
        path = ASSETS / name
        if not path.is_file():
            raise ValueError(f"missing Emscripten HTTP asset: {path}")
        digest.update(name.encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def _inventory(root: Path) -> dict[str, str]:
    files = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"HTTP adapter must not contain symlinks: {path}")
        if path.is_file() and path != root / ".ready":
            files[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return files


def _paths(root: Path) -> dict[str, Path]:
    for name, (relative, version) in DIRECTORIES.items():
        path = root / relative
        package = tomllib.loads((path / "Cargo.toml").read_text())["package"]
        if (package["name"], package["version"]) != (name, version):
            raise ValueError(f"expected {name} {version} at {path}")
    reqwest = root / DIRECTORIES["reqwest"][0]
    http = root / DIRECTORIES["agentos-wasi-http"][0]
    reqwest_manifest = tomllib.loads((reqwest / "Cargo.toml").read_text())
    http_manifest = tomllib.loads((http / "Cargo.toml").read_text())
    if ((reqwest / reqwest_manifest["dependencies"]["wasi-http"]["path"]).resolve() != http.resolve()
            or (http / http_manifest["dependencies"]["wasi-ext"]["path"]).resolve()
            != (root / DIRECTORIES["wasi-ext"][0]).resolve()):
        raise ValueError("HTTP adapter relative dependencies changed")
    return {"reqwest": reqwest}


def prepare_emscripten_http(cache: Path, sources: dict[str, Path]) -> dict[str, Path]:
    """Return only reqwest 0.12 as a workspace patch; preserve reqwest 0.13.

    Archive the fixed AgentOS commit into an atomic cache stage. The selected
    WASI fixes are copied verbatim with only their archive path prefixes changed.
    They do not establish HTTP, TLS or provider behavior on Emscripten.
    """
    cache = cache_root(cache, sources)
    agentos = sources["agentos"]
    with locked(cache):
        identity = _identity()
        root = cache / f"emscripten-http-{identity[:16]}"
        if root.is_symlink() or any(source.resolve().is_relative_to(root) for source in sources.values()):
            raise ValueError(f"HTTP adapter must not contain or redirect to sources: {root}")
        if root.exists():
            files = _inventory(root)
            paths = _paths(root)
            ready = json.loads((root / ".ready").read_text())
            if ready != {"identity": identity, "files": files}:
                raise ValueError(f"Emscripten HTTP cache changed: {root}")
            return paths
        with tempfile.TemporaryDirectory(prefix=".emscripten-http-", dir=cache) as temporary:
            stage = Path(temporary)
            git_archive(agentos, AGENTOS, [relative for relative, _ in DIRECTORIES.values()], stage)
            _inventory(stage)
            patch_series(stage, [ASSETS / "reuse.patch"])
            _paths(stage)
            (stage / ".ready").write_text(json.dumps({"identity": identity, "files": _inventory(stage)},
                                                   sort_keys=True))
            stage.rename(root)
        return _paths(root)
