"""Isolated Rust/SDK installation and agentOS libc preparation."""

import hashlib
import os
from pathlib import Path
import platform
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile

from .staging import AGENTOS, ASSETS, download, extract, git_archive, patch_series, run

NIGHTLY = "nightly-2026-03-01"
LIBC = "574b88da481569b65a237cb80daf9a2d5aeaf82d"


def _sdk_name() -> str:
    arch = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "x86_64"}.get(platform.machine())
    system = {"Darwin": "macos", "Linux": "linux"}.get(platform.system())
    if not arch or not system:
        raise RuntimeError("WASI SDK 25 preparation supports macOS/Linux on arm64/x86_64")
    return f"wasi-sdk-25.0-{arch}-{system}"


def _identity() -> str:
    digest = hashlib.sha256(f"{NIGHTLY}:{LIBC}:{AGENTOS}:{_sdk_name()}:libc-v2".encode())
    # Quiet make changes output volume, not the sysroot being built.
    digest.update((ASSETS / "build-wasi-libc.sh").read_bytes().replace(b"make -s -C", b"make -C"))
    for asset in sorted((ASSETS / "patches/std").glob("*.patch")):
        digest.update(asset.read_bytes())
    return digest.hexdigest()


def _legacy_identity(root: Path) -> str | None:
    launcher = root / "cargo.py"
    if not launcher.is_file():
        return None
    digest = hashlib.sha256(f"{NIGHTLY}:{LIBC}:{AGENTOS}:{_sdk_name()}:v1".encode())
    digest.update((ASSETS / "build-wasi-libc.sh").read_bytes().replace(b"make -s -C", b"make -C"))
    digest.update(launcher.read_bytes())
    for asset in sorted((ASSETS / "patches/std").glob("*.patch")):
        digest.update(asset.read_bytes())
    return digest.hexdigest()


def _refresh_launcher(root: Path):
    cargo = root / "cargo.py"
    content = (ASSETS / "cargo.py").read_bytes()
    if not cargo.exists() or cargo.read_bytes() != content:
        cargo.write_bytes(content)
    launcher = root / "cargo-wasi"
    content = "#!/bin/sh\nexec " + shlex.join([sys.executable, str(cargo)]) + ' "$@"\n'
    if not launcher.exists() or launcher.read_text() != content:
        launcher.write_text(content)
        launcher.chmod(0o755)


def _environment(root: Path, rustup: str) -> dict[str, str]:
    sdk = root / "wasi-sdk"
    lib = root / "sysroot/lib/wasm32-wasi"
    env = {
        "RUSTUP_HOME": str(root / "rustup"),
        "CARGO_HOME": str(root / "cargo-home"),
        "RUSTUP_TOOLCHAIN": NIGHTLY,
        "WASI_SDK_DIR": str(sdk),
        "CC_wasm32_wasip1": str(sdk / "bin/clang"),
        "CXX_wasm32_wasip1": str(sdk / "bin/clang++"),
        "AR_wasm32_wasip1": str(sdk / "bin/llvm-ar"),
        "CFLAGS_wasm32_wasip1": shlex.join([
            f"--sysroot={root / 'sysroot'}", "-D_WASI_EMULATED_SIGNAL", "-D_WASI_EMULATED_PTHREAD",
            "-D_WASI_EMULATED_MMAN", "-D_WASI_EMULATED_PROCESS_CLOCKS",
        ]),
        "CARGO_TARGET_DIR": str(root / "target"),
        "CARGO": str(root / "cargo-wasi"),
        "SIGNALBOX_WASI_RUSTUP": rustup,
        "CARGO_PROFILE_RELEASE_DEBUG": "none",
        "CARGO_PROFILE_RELEASE_STRIP": "symbols",
        "CARGO_PROFILE_RELEASE_LTO": "thin",
        "CARGO_PROFILE_RELEASE_CODEGEN_UNITS": "16",
        "CARGO_PROFILE_RELEASE_OPT_LEVEL": "z",
        "CARGO_PROFILE_RELEASE_PANIC": "abort",
        "CARGO_INCREMENTAL": "0",
    }
    if (lib / "libc.a").exists():
        digest = hashlib.sha256((lib / "libc.a").read_bytes()).hexdigest()[:16]
        # Cargo splits this variable on whitespace; encoded flags preserve paths with spaces.
        flags = ["-C", "link-self-contained=no"]
        for argument in ["crt1-command.o", "libc.a", "libwasi-emulated-pthread.a", "libwasi-emulated-signal.a",
                         "libwasi-emulated-mman.a", "libwasi-emulated-process-clocks.a"]:
            flags += ["-C", f"link-arg={lib / argument}"]
        flags += ["-C", f"link-arg=-L{lib}", "-C", f"metadata=agentos-libc-{digest}", "--cfg", "tokio_unstable"]
        env["CARGO_ENCODED_RUSTFLAGS"] = "\x1f".join(flags)
    return env


def _rust_identity() -> str:
    digest = hashlib.sha256(f"{NIGHTLY}:{AGENTOS}:{LIBC}:{_sdk_name()}".encode())
    for asset in sorted((ASSETS / "patches/std").glob("*.patch")):
        digest.update(asset.read_bytes())
    return digest.hexdigest()


def _legacy_sysroot(root: Path) -> Path | None:
    """Recognize a fully patched installation made before phase markers existed."""
    candidates = list((root / "rustup/toolchains").glob(f"{NIGHTLY}-*"))
    tc = root / "agentos-toolchain/toolchain"
    if len(candidates) != 1 or not (tc / "std-patches/copy.manifest").is_file():
        return None
    sysroot = candidates[0].resolve()
    patches = sorted((tc / "std-patches").glob("*.patch")) + sorted((ASSETS / "patches/std").glob("*.patch"))
    # Validate the complete series in reverse, without touching installed rust-src.
    with tempfile.TemporaryDirectory(prefix=".std-resume-", dir=root.parent) as temporary:
        copied = Path(temporary)
        std = sysroot / "lib/rustlib/src/rust"
        for patch in patches:
            for line in patch.read_text().splitlines():
                if line.startswith("+++ b/"):
                    relative = line.split()[1][2:]
                    source = std / relative
                    if source.is_file():
                        (copied / relative).parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(source, copied / relative)
        try:
            for patch in reversed(patches):
                with patch.open("rb") as stream:
                    run(["patch", "-R", "-p1", "--batch", "--force", "-d", copied], stdin=stream,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except subprocess.CalledProcessError:
            return None
    return sysroot


def _root(cache: Path, rust_identity: str, sources: dict[str, Path]) -> Path:
    preferred = cache / f"wasi-toolchain-{rust_identity[:16]}"
    if preferred.exists():
        return preferred
    for candidate in sorted(cache.glob("wasi-toolchain-*")):
        if candidate.is_symlink() or not candidate.is_dir():
            continue
        if any(source.resolve().is_relative_to(candidate) for source in sources.values()):
            continue
        marker = candidate / ".rust-ready"
        if marker.exists() and marker.read_text() == rust_identity:
            return candidate
        if not marker.exists():
            sysroot = _legacy_sysroot(candidate)
            if sysroot is not None:
                (candidate / "rust-sysroot").write_text(str(sysroot))
                marker.write_text(rust_identity)
                return candidate
    return preferred


def prepare(cache: Path, sources: dict[str, Path]) -> dict[str, str]:
    rustup = shutil.which("rustup")
    if rustup is None:
        raise RuntimeError("rustup executable required; preparation never installs into the user's Cargo home")
    identity = _identity()
    rust_identity = _rust_identity()
    root = _root(cache, rust_identity, sources)
    if any(source.resolve().is_relative_to(root) for source in sources.values()):
        raise ValueError("toolchain output must not contain a source checkout")
    if root.is_symlink():
        raise ValueError(f"toolchain cache must not be a symlink: {root}")
    root.mkdir(exist_ok=True)
    marker = root / ".ready"
    env = {**os.environ, **_environment(root, rustup)}
    for inherited in ["RUSTC", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS"]:
        env.pop(inherited, None)
    tc = root / "agentos-toolchain/toolchain"
    rust_marker = root / ".rust-ready"
    if not rust_marker.exists() or rust_marker.read_text() != rust_identity:
        # Retry an interrupted std phase from pristine private rust-src only.
        for directory in [root / "rustup", root / "agentos-toolchain"]:
            if directory.exists():
                shutil.rmtree(directory)
        run([rustup, "toolchain", "install", NIGHTLY, "--profile", "minimal", "--component", "rust-src",
             "--target", "wasm32-wasip1"], env=env)
        sysroot = Path(run([rustup, "run", NIGHTLY, "rustc", "--print", "sysroot"], env=env,
                           stdout=subprocess.PIPE, text=True).stdout.strip()).resolve()
        if not sysroot.is_relative_to(root / "rustup"):
            raise ValueError(f"rustup returned a sysroot outside wrapper cache: {sysroot}")
        git_archive(sources["agentos"], AGENTOS,
                    ["toolchain/std-patches", "toolchain/c/include", "toolchain/rust-toolchain.toml"], root / "agentos-toolchain")
        std = sysroot / "lib/rustlib/src/rust"
        patch_series(std, (tc / "std-patches").glob("*.patch"))
        for line in (tc / "std-patches/copy.manifest").read_text().splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            source, target = line.split()
            (std / target).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(tc / "std-patches" / source, std / target)
        patch_series(std, (ASSETS / "patches/std").glob("*.patch"))
        libdir = sysroot / "lib/rustlib/wasm32-wasip1/lib"
        for pattern in ["*.rlib", "*.rmeta"]:
            for prebuilt in libdir.glob(pattern):
                prebuilt.unlink()
        (root / "rust-sysroot").write_text(str(sysroot))
        rust_marker.write_text(rust_identity)
    ready = marker.exists() and marker.read_text() in (identity, _legacy_identity(root))
    if not ready:
        if not (root / "wasi-sdk/bin/clang").is_file():
            sdk_name = _sdk_name()
            sdk_archive = download(f"https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/{sdk_name}.tar.gz",
                                   cache / "downloads" / f"{sdk_name}.tar.gz")
            with tarfile.open(sdk_archive, "r:gz") as archive:
                extract(archive, root)
            (root / sdk_name).rename(root / "wasi-sdk")
        libc_repo = root / "wasi-libc.git"
        if not libc_repo.exists():
            run(["git", "init", "--bare", libc_repo])
            run(["git", "-C", libc_repo, "fetch", "--depth=1", "https://github.com/WebAssembly/wasi-libc.git", LIBC])
        # The previous libc patch phase may have stopped partway through its series.
        libc = root / "wasi-libc"
        if libc.exists():
            shutil.rmtree(libc)
        git_archive(libc_repo, LIBC, [], libc)
        run(["bash", ASSETS / "build-wasi-libc.sh"],
            env={**env, "CL": str(root), "AOS_TC": str(tc)})
        for name in ["libc.a", "crt1-command.o", "libwasi-emulated-pthread.a", "libwasi-emulated-signal.a",
                     "libwasi-emulated-mman.a", "libwasi-emulated-process-clocks.a"]:
            if not (root / "sysroot/lib/wasm32-wasi" / name).is_file():
                raise RuntimeError(f"patched sysroot output missing: {name}")
    _refresh_launcher(root)
    marker.write_text(identity)
    env = _environment(root, rustup)
    sysroot = Path((root / "rust-sysroot").read_text())
    env["RUSTC"] = str(sysroot / "bin/rustc")
    env["RUSTDOC"] = str(sysroot / "bin/rustdoc")
    env["SIGNALBOX_WASI_RUST_SYSROOT"] = str(sysroot)
    env["RUSTC_WRAPPER"] = ""
    env["RUSTC_WORKSPACE_WRAPPER"] = ""
    return env
