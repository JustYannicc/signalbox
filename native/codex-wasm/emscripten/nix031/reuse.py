#!/usr/bin/env python3.11
"""Reproduce the Emscripten API compatibility patch from pinned nix 0.31.3."""

import argparse
import difflib
import hashlib
from pathlib import Path
import tarfile
import textwrap

VERSION = "0.31.3"
CHECKSUM = "cf20d2fde8ff38632c426f1165ed7436270b44f199fc55284c38276f9db47c3d"


def source(archives: Path, version: str, file: str) -> str:
    path = archives / f"nix-{version}.crate"
    if version != VERSION or hashlib.sha256(path.read_bytes()).hexdigest() != CHECKSUM:
        raise ValueError("nix 0.31.3 archive checksum mismatch")
    with tarfile.open(path, "r:gz") as archive:
        member = archive.extractfile(f"nix-{version}/{file}")
        if member is None:
            raise ValueError("Crate archive member is not a file")
        return member.read().decode()


def unsupported_body(body: str, indent: str, reason: str, unused: str = "") -> str:
    branch = indent + "    "
    return (
        f'{indent}#[cfg(target_os = "emscripten")]\n{indent}{{\n'
        f'{branch}// {reason}\n'
        + (f"{branch}let _ = {unused};\n" if unused else "")
        + f'{branch}Err(Errno::ENOSYS)\n{indent}}}\n'
        f'{indent}#[cfg(not(target_os = "emscripten"))]\n{indent}{{\n'
        + textwrap.indent(body, "    ") + indent + "}\n"
    )


def adapt(archives: Path) -> dict[str, str]:
    signal = source(archives, "0.31.3", "src/sys/signal.rs")
    start = signal.index("    pub fn wait(&self) -> Result<Signal> {") + len(
        "    pub fn wait(&self) -> Result<Signal> {\n")
    end = signal.index("    }\n", start)
    signal = signal[:start] + unsupported_body(
        signal[start:end], "        ",
        "SDK 4.0.10 sigwait only checks emulated pending signals; this carrier cannot wait for OS signals.",
    ) + signal[end:]
    start = signal.index("    let res = unsafe {", signal.index("fn do_pthread_sigmask("))
    end = signal.index("}\n", signal.index("    Errno::result(res).map(drop)", start))
    signal = signal[:start] + unsupported_body(
        signal[start:end], "    ",
        "SDK 4.0.10 pthread_sigmask dereferences a null set for queries; this carrier has no OS thread masks.",
        "how",
    ) + signal[end:]
    unistd = source(archives, "0.31.3", "src/unistd.rs")
    binding = """
#[cfg(all(feature = "fs", target_os = "emscripten"))]
mod emscripten_compat {
    extern "C" {
        // SDK 4.0.10 unistd.h and libc.a define this ABI; Rust libc 0.2.186 omits it.
        pub(super) fn faccessat(
            dirfd: libc::c_int,
            path: *const libc::c_char,
            mode: libc::c_int,
            flags: libc::c_int,
        ) -> libc::c_int;
    }
}
"""
    anchor = "use crate::errno::Errno;\n"
    unistd = unistd.replace(anchor, anchor + binding, 1)
    start = unistd.index("        libc::faccessat(", unistd.index("pub fn faccessat<"))
    end = unistd.index("    })?;", start)
    original = unistd[start:end]
    unistd = unistd[:start] + (
        '        #[cfg(target_os = "emscripten")]\n        {\n'
        + textwrap.indent(original.replace("libc::faccessat(", "emscripten_compat::faccessat("), "    ")
        + '        }\n        #[cfg(not(target_os = "emscripten"))]\n        {\n'
        + textwrap.indent(original, "    ") + "        }\n"
    ) + unistd[end:]
    return {"src/sys/signal.rs": signal, "src/unistd.rs": unistd}


def expected_patch(archives: Path) -> str:
    return "".join("".join(difflib.unified_diff(
        source(archives, VERSION, file).splitlines(True), candidate.splitlines(True),
        "a/nix_031/" + file, "b/nix_031/" + file)) for file, candidate in adapt(archives).items())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archives", type=Path)
    args = parser.parse_args()
    patch = Path(__file__).resolve().parents[1] / "patches/nix_031.patch"
    if patch.read_text() != expected_patch(args.archives):
        raise ValueError("nix_031.patch differs from pinned native bodies and carrier API decision")
    print("PASS: nix 0.31.3 archive pin, preserved native bodies, explicit signal rejection, SDK faccessat ABI")


if __name__ == "__main__":
    main()
