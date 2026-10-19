#!/usr/bin/env python3.11
"""Reproduce the Emscripten-only errno backport from checksum-pinned releases."""

import argparse
import difflib
import hashlib
from pathlib import Path
import re
import tarfile
import textwrap

# Both archive hashes occur in the pinned Codex release's Cargo.lock.
RELEASES = {
    "0.28.0": "ab2156c4fce2f8df6c499cc1c763e4394b7482525bf2a9701c9d79d215f519e4",
    "0.31.3": "cf20d2fde8ff38632c426f1165ed7436270b44f199fc55284c38276f9db47c3d",
}
UPSTREAM_COMMIT = "b5933ca178802b558a667514f717a86b3a1cedcc"
UPSTREAM_SOURCE = f"https://github.com/nix-rust/nix/blob/{UPSTREAM_COMMIT}/src/errno.rs"
CFG = re.compile(r"#\[cfg\((.*?)\)\]", re.DOTALL)
EMS = 'target_os = "emscripten"'


def source(archives: Path, version: str, file: str) -> str:
    path = archives / f"nix-{version}.crate"
    if hashlib.sha256(path.read_bytes()).hexdigest() != RELEASES[version]:
        raise ValueError(f"nix {version} archive checksum mismatch")
    with tarfile.open(path, "r:gz") as archive:
        member = archive.extractfile(f"nix-{version}/{file}")
        if member is None:
            raise ValueError("Crate archive member is not a file")
        return member.read().decode()


def errno(archives: Path, version: str) -> str:
    return source(archives, version, "src/errno.rs")


def backport(original: str, upstream: str) -> str:
    boundary = original.index("mod consts {")
    prefix, constants = original[:boundary], original[boundary:]
    upstream_boundary = upstream.index("mod consts {")
    # The Linux/Fuchsia table already has the exact Emscripten values and conversion.
    if constants[:constants.index("#[cfg(apple_targets)]")] != upstream[
            upstream_boundary:upstream.index("#[cfg(apple_targets)]", upstream_boundary)]:
        raise ValueError("upstream constants no longer match the old crate")

    def enable(match):
        text = match.group()
        if match.start() < original.index("fn desc(") or 'target_os = "fuchsia"' not in text:
            return text
        if "\n" in text:
            return text.replace('target_os = "fuchsia"',
                                'target_os = "emscripten",\n            target_os = "fuchsia"')
        return text.replace('target_os = "fuchsia"',
                            'target_os = "fuchsia", ' + EMS)

    prefix = CFG.sub(enable, prefix)
    prefix = prefix.replace('target_os = "hurd"))] {',
                            'target_os = "hurd",\n                        ' + EMS + '))] {')
    # Each description arm and module must select exactly what later upstream selects.
    def ems_items(text):
        result = []
        for match in CFG.finditer(text[:text.index("mod consts {")]):
            if EMS in match.group():
                result.append(text[match.end():].lstrip().splitlines()[0])
        return result

    candidate = prefix + constants
    if ems_items(candidate) != ems_items(upstream):
        raise ValueError("Emscripten cfg selections differ from pinned upstream")
    if candidate.replace(EMS + ',\n            ', '').replace(', ' + EMS, '').replace(
            ',\n                        ' + EMS, '') != original:
        raise ValueError("backport changed more than Emscripten cfg predicates")
    return candidate


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


def api_backport(archives: Path) -> dict[str, str]:
    signal = source(archives, "0.28.0", "src/sys/signal.rs")
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
    unistd = source(archives, "0.28.0", "src/unistd.rs")
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
    files = {"src/errno.rs": backport(errno(archives, "0.28.0"), errno(archives, "0.31.3")),
             **api_backport(archives)}
    return "".join("".join(difflib.unified_diff(
        source(archives, "0.28.0", file).splitlines(True), candidate.splitlines(True),
        "a/nix/" + file, "b/nix/" + file)) for file, candidate in files.items())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archives", type=Path, help="directory containing both official .crate archives")
    args = parser.parse_args()
    expected = expected_patch(args.archives)
    patch = Path(__file__).resolve().parents[1] / "patches/nix.patch"
    if patch.read_text() != expected:
        raise ValueError("nix.patch differs from the verified upstream errno and carrier API backport")
    print(UPSTREAM_SOURCE)
    print("PASS: archive hashes, upstream errno cfg delta, preserved native bodies, explicit carrier signal rejection, SDK faccessat ABI")


if __name__ == "__main__":
    main()
