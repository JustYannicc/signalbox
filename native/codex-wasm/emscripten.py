"""Pinned, cache-local official emsdk; reuse the wrapper's existing Rust install.

Call under heavy-slot. This may download/install the SDK, never Rust. Build with
--target wasm32-unknown-emscripten -Z build-std=std,panic_abort. Package Cargo's
generated .js as engine.mjs beside engine.wasm and loader-emscripten.mjs.
"""

import json
import os
from pathlib import Path
import platform
import re
import shlex
import subprocess
import sys
import tarfile
import tempfile

from dependencies.staging import download, extract, locked, run

SDK_VERSION = "4.0.10"
EMSDK_COMMIT = "62a853cd3b3134398ce85cde8bb5cbb2ef0194cb"
EMSDK_ARCHIVE_SHA256 = "7e97513705790405f9c385b6a73e380a69139c5d23913a1320bb009e6e1595dc"
SDK_RELEASE = "8103ffedfb0c42d231c6af6859a5a1a832260b43"
NIGHTLY = "nightly-2026-03-01"
LINK_LIBRARY = Path(__file__).resolve().parent / "emscripten/patches/imports.js"
HTTP_LINK_LIBRARY = Path(__file__).resolve().parent / "emscripten/http/imports.js"

# Official 4.0.10 settings and glue, not the current development docs:
# https://github.com/emscripten-core/emscripten/blob/4.0.10/src/settings.js
# https://github.com/emscripten-core/emscripten/blob/4.0.10/src/postamble.js
# https://github.com/emscripten-core/emscripten/blob/4.0.10/src/preamble.js
LINK_FLAGS = (
    "-sJSPI=1",
    '-sJSPI_EXPORTS=["main"]',
    "-sMODULARIZE=1",
    "-sEXPORT_ES6=1",
    "-sINVOKE_RUN=0",
    "-sEXIT_RUNTIME=1",
    '-sEXPORTED_RUNTIME_METHODS=["callMain"]',
    "-sENVIRONMENT=web,worker",
    # Workerd has neither window nor WorkerGlobalScope. Its static module is
    # instantiated by our callback, so browser detection/loading is unnecessary.
    "-sASSERTIONS=0",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sSHARED_MEMORY=0",
    "-sWASM_WORKERS=0",
)


def _inside(path: Path, root: Path) -> Path:
    resolved = path.resolve()
    if not resolved.is_relative_to(root):
        raise ValueError(f"toolchain path outside wrapper cache: {path}")
    return resolved


def _rust(cache: Path, base: dict[str, str]) -> Path:
    if base.get("RUSTUP_TOOLCHAIN") != NIGHTLY:
        raise ValueError(f"Emscripten requires the prepared {NIGHTLY} Rust install")
    for key in ("RUSTUP_HOME", "CARGO_HOME", "RUSTC"):
        if not base.get(key):
            raise ValueError(f"prepared Rust environment is missing {key}")
        _inside(Path(base[key]), cache)
    rustc = Path(base["RUSTC"]).resolve()
    _inside(rustc, Path(base["RUSTUP_HOME"]).resolve())
    cargo = rustc.with_name("cargo")
    if not rustc.is_file() or not cargo.is_file():
        raise ValueError("prepared Rust install must contain rustc and cargo")
    return cargo


def _sdk_environment(root: Path, base: dict[str, str]) -> dict[str, str]:
    env = {**os.environ, **base}
    # Inherited SDK options can redirect compiler output or select another SDK.
    for key in list(env):
        if key.startswith(("EMSDK", "EMCC_")) or key in (
            "EM_CONFIG", "EM_CACHE", "EM_PORTS", "EM_LLVM_ROOT", "EM_BINARYEN_ROOT",
            "EM_NODE_JS", "LLVM_ROOT", "BINARYEN_ROOT", "NODE_OPTIONS", "NODE_PATH",
        ):
            env.pop(key)
    env.update({
        "EMSDK": str(root),
        "EM_CONFIG": str(root / ".emscripten"),
        "EM_CACHE": str(root / "upstream/emscripten/cache"),
        "EM_PORTS": str(root / "ports"),
        "EMSDK_PYTHON": sys.executable,
        "EMSDK_NUM_CORES": "2",
        "EMSDK_NOTTY": "1",
        "npm_config_cache": str(root / "npm-cache"),
        "npm_config_prefix": str(root / "npm-prefix"),
        "npm_config_userconfig": str(root / "npmrc"),
        "npm_config_globalconfig": str(root / "npmrc-global"),
        "TMPDIR": str(root / "tmp"),
        "TMP": str(root / "tmp"),
        "TEMP": str(root / "tmp"),
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    return env


def _activated_environment(root: Path, env: dict[str, str]) -> dict[str, str]:
    # Official activation writes a relative Python config. Evaluate it in a
    # subprocess with EM_CONFIG set, without changing this process's environment.
    script = (
        "import json,os,runpy; c=runpy.run_path(os.environ['EM_CONFIG']); "
        "print(json.dumps({k:c[k] for k in ('LLVM_ROOT','BINARYEN_ROOT','NODE_JS')}))"
    )
    config = json.loads(run([sys.executable, "-c", script], cwd=root, env=env,
                            stdout=subprocess.PIPE, text=True).stdout)
    llvm = _inside(Path(config["LLVM_ROOT"]), root)
    binaryen = _inside(Path(config["BINARYEN_ROOT"]), root)
    node = config["NODE_JS"]
    node = _inside(Path(node[0] if isinstance(node, list) else node), root)
    for executable in (node, llvm / "clang", binaryen / "bin/wasm-opt"):
        if not executable.is_file():
            raise ValueError(f"activated emsdk tool missing: {executable}")
    return {**env, "EMSDK_NODE": str(node), "PATH": os.pathsep.join([
        str(root), str(root / "upstream/emscripten"), str(llvm), str(node.parent), env.get("PATH", ""),
    ])}


def _prepare_sdk(cache: Path, root: Path, base: dict[str, str]) -> dict[str, str]:
    if root.is_symlink():
        raise ValueError(f"emsdk cache must not be a symlink: {root}")
    if not root.exists():
        archive = download(
            f"https://codeload.github.com/emscripten-core/emsdk/tar.gz/{EMSDK_COMMIT}",
            cache / "downloads" / f"emsdk-{EMSDK_COMMIT}.tar.gz", EMSDK_ARCHIVE_SHA256)
        with tempfile.TemporaryDirectory(prefix=".emsdk-", dir=cache) as temporary:
            stage = Path(temporary)
            with tarfile.open(archive, "r:gz") as contents:
                extract(contents, stage)
            (stage / f"emsdk-{EMSDK_COMMIT}").rename(root)
    for directory in ("tmp", "npm-cache", "npm-prefix", "ports"):
        _inside(root / directory, root).mkdir(parents=True, exist_ok=True)
    env = _sdk_environment(root, base)
    tags = json.loads((root / "emscripten-releases-tags.json").read_text())
    if tags["releases"].get(SDK_VERSION) != SDK_RELEASE:
        raise ValueError("emsdk release pin mismatch")
    marker = root / ".ready"
    identity = f"{EMSDK_COMMIT}:{SDK_VERSION}:{SDK_RELEASE}"
    if marker.exists() and marker.read_text() != identity:
        raise ValueError("emsdk cache identity mismatch")
    if not marker.exists():
        for operation in ("install", "activate"):
            run([sys.executable, root / "emsdk.py", operation, SDK_VERSION], cwd=root, env=env)
    env = _activated_environment(root, env)
    emcc = root / "upstream/emscripten/emcc"
    version = run([emcc, "--version"], cwd=root, env=env, stdout=subprocess.PIPE, text=True).stdout
    if not re.search(rf"\bemcc\b[^\n]*\b{re.escape(SDK_VERSION)}\b", version):
        raise ValueError(f"activated emcc is not {SDK_VERSION}: {version.strip()}")
    marker.write_text(identity)
    return env


def prepare_emscripten_toolchain(cache: Path, base_env: dict[str, str]) -> dict[str, str]:
    """Return a complete environment, including a normal-argument CARGO launcher.

    base_env is prepare_wasi_toolchain's result. Its Rust install/rust-src is
    reused unchanged; WASI link flags and the WASI panic-runtime retry are not.
    No pthreads, shared memory, standalone WASI mode, or Asyncify transform.
    Kernel imports may suspend via host.suspendingImports in the loader. Extra
    generated async JS library imports need JSPI_IMPORTS or __async at link time.
    """
    if platform.system() not in ("Darwin", "Linux") or platform.machine() not in (
        "arm64", "aarch64", "x86_64",
    ):
        raise RuntimeError("emsdk preparation supports macOS/Linux on arm64/x86_64")
    cache = cache.resolve()
    cargo = _rust(cache, base_env)
    cache.mkdir(parents=True, exist_ok=True)
    root = cache / f"emsdk-{SDK_VERSION}-{EMSDK_COMMIT[:12]}"
    with locked(cache):
        env = _prepare_sdk(cache, root, base_env)
        launcher = root / "cargo-emscripten"
        launcher.write_text("#!/bin/sh\nexec " + shlex.quote(str(cargo)) + ' "$@"\n')
        launcher.chmod(0o755)
    emscripten = root / "upstream/emscripten"
    for key in ("RUSTFLAGS", "CARGO_BUILD_RUSTFLAGS", "CARGO_TARGET_WASM32_UNKNOWN_EMSCRIPTEN_RUSTFLAGS",
                "CFLAGS", "CXXFLAGS", "LDFLAGS", "EMCC_CFLAGS"):
        env[key] = ""
    env.update({
        "CARGO": str(launcher),
        "CARGO_TARGET_DIR": str(root / "target"),
        "CARGO_TARGET_WASM32_UNKNOWN_EMSCRIPTEN_LINKER": str(emscripten / "emcc"),
        "CC_wasm32_unknown_emscripten": str(emscripten / "emcc"),
        "CXX_wasm32_unknown_emscripten": str(emscripten / "em++"),
        "AR_wasm32_unknown_emscripten": str(emscripten / "emar"),
        "CFLAGS_wasm32_unknown_emscripten": "",
        "CXXFLAGS_wasm32_unknown_emscripten": "",
        "ARFLAGS_wasm32_unknown_emscripten": "",
        "RUSTC_WRAPPER": "",
        "RUSTC_WORKSPACE_WRAPPER": "",
        "CARGO_ENCODED_RUSTFLAGS": "\x1f".join([
            "--cfg", "tokio_unstable",
            "-C", f"link-arg=--js-library={LINK_LIBRARY}",
            "-C", f"link-arg=--js-library={HTTP_LINK_LIBRARY}",
            *[value for flag in LINK_FLAGS for value in ("-C", f"link-arg={flag}")],
        ]),
    })
    return env
