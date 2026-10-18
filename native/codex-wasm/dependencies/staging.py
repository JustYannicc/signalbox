"""Pinned archive staging; never reads Cargo's global registry."""

from contextlib import contextmanager
import fcntl
import hashlib
import io
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request

AGENTOS = "63ae3b256749d47c7b3a7c463128d5deda57d1bb"
RIVET_CODEX = "8f4655a9dbfc7db91768c78ccaea7357ba47127e"
DIGIBUGCAT = "45eca7daf24bbac603689cc3229693310d184e51"
ASSETS = Path(__file__).resolve().parent

# SHA-256 values published by the crates.io version API.
CRATES = {
    "rustls-native-certs": ("0.8.3", "612460d5f7bea540c490b2b6395d8e34a953e52b491accd6c86c8164c5932a63"),
    "tokio-graceful": ("0.2.2", "45740b38b48641855471cd402922e89156bdfbd97b69b45eeff170369cc18c7d"),
    "gethostname": ("1.1.0", "1bd49230192a3797a9a4d6abe9b3eed6f7fa4c8a8a4947977c6f80025f92cbd8"),
    "hyper-util": ("0.1.20", "96547c2556ec9d12fb1578c4eaf448b04993e7fb79cbaad930a656880a6bdfa0"),
    "libc": ("0.2.186", "68ab91017fe16c622486840e4c83c9a37afeff978bd239b5293d61ece587de66"),
    "socket2": ("0.6.5", "c3d1e2c7f27f8d4cb10542a02c49005dbd6e93095799d6f3be745fae9f8fedd4"),
    "tonic": ("0.14.3", "a286e33f82f8a1ee2df63f4fa35c0becf4a85a0cb03091a15fd7bf0b402dc94a"),
    "opentelemetry-http": ("0.31.0", "d7a6d09a73194e6b66df7c8f1b680f156d916a1a942abf2de06823dd02b7855d"),
    "rama-net": ("0.3.0-alpha.4", "b28ee9e1e5d39264414b71f5c33e7fbb66b382c3fac456fe0daad39cf5509933"),
    "rama-tcp": ("0.3.0-alpha.4", "fe60cd604f91196b3659a1b28945add2e8b10bd0b4e6373c93d024fb3197704b"),
    "rama-udp": ("0.3.0-alpha.4", "36ed05e0ecac73e084e92a3a8b1fbf16fdae8958c506f0f0eada180a2d99eef4"),
    "gix-fs": ("0.19.2", "a964b4aec683eb0bacb87533defa80805bb4768056371a47ab38b00a2d377b72"),
}


def run(args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def cache_root(cache: Path, sources: dict[str, Path]) -> Path:
    cache = cache.resolve()
    for source in sources.values():
        source = source.resolve()
        if cache.is_relative_to(source):
            raise ValueError("preparation cache must not be inside a source checkout")
    cache.mkdir(parents=True, exist_ok=True)
    return cache


@contextmanager
def locked(cache: Path):
    with (cache / ".prepare.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def extract(archive: tarfile.TarFile, destination: Path):
    destination.mkdir(parents=True, exist_ok=True)
    root = destination.resolve()
    for member in archive:
        target = root / member.name
        if not target.resolve().is_relative_to(root):
            raise ValueError(f"archive path escapes destination: {member.name}")
        if member.issym() or member.islnk():
            base = target.parent if member.issym() else root
            if not (base / member.linkname).resolve().is_relative_to(root):
                raise ValueError(f"archive link escapes destination: {member.name}")
        elif not (member.isfile() or member.isdir()):
            raise ValueError(f"unsupported archive entry: {member.name}")
        archive.extract(member, root)


def git_archive(repo: Path, revision: str, paths: list[str], destination: Path):
    data = run(["git", "-C", repo, "archive", revision, *paths], stdout=subprocess.PIPE).stdout
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        extract(archive, destination)


def download(url: str, destination: Path, checksum: str | None = None) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        partial = destination.with_suffix(destination.suffix + ".partial")
        try:
            with urllib.request.urlopen(url, timeout=120) as response, partial.open("wb") as out:
                shutil.copyfileobj(response, out)
            if checksum and hashlib.sha256(partial.read_bytes()).hexdigest() != checksum:
                raise ValueError(f"SHA-256 mismatch for {url}")
            partial.replace(destination)
        finally:
            partial.unlink(missing_ok=True)
    if checksum and hashlib.sha256(destination.read_bytes()).hexdigest() != checksum:
        raise ValueError(f"SHA-256 mismatch for cached {destination.name}; remove it and retry")
    return destination


def patch_series(root: Path, patches):
    for patch in sorted(patches):
        with patch.open("rb") as stream:
            run(["patch", "-p1", "--batch", "--forward", "-d", root], stdin=stream)
