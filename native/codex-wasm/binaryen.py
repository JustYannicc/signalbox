"""Pinned wasm-opt, installed only in the wrapper cache."""

from pathlib import Path
import platform
import tarfile

from dependencies.staging import download, extract

VERSION = "version_126"
ARCHIVES = {
    ("Darwin", "arm64"): ("arm64-macos", "3f1e1379894944531501a8ccc6b59c57f0c7a00fc136dd933f8a6b0c53515a88"),
    ("Linux", "x86_64"): ("x86_64-linux", "e487e0eac1f02a6739816c617270b033e5d3f8ca90439301fd0286460322fd76"),
}


def prepare_binaryen(cache: Path) -> Path:
    try:
        target, checksum = ARCHIVES[(platform.system(), platform.machine())]
    except KeyError:
        raise ValueError("Pinned Binaryen currently supports macOS arm64 and Linux x86_64") from None
    root = cache / f"binaryen-{VERSION}-{target}"
    binary = root / f"binaryen-{VERSION}" / "bin/wasm-opt"
    if not binary.is_file():
        name = f"binaryen-{VERSION}-{target}.tar.gz"
        archive = download(f"https://github.com/WebAssembly/binaryen/releases/download/{VERSION}/{name}",
                           cache / "downloads" / name, checksum)
        with tarfile.open(archive, "r:gz") as contents:
            extract(contents, root)
    if not binary.is_file():
        raise ValueError("Binaryen archive did not contain wasm-opt")
    return binary
