"""Cache-local adaptation of DigiBugCat's build-wasm panic_abort workaround."""

import fcntl
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


def place_panic_runtime(target: Path, libdir: Path) -> bool:
    changed = False
    for profile in ["debug", "release"]:
        for suffix in ["rlib", "rmeta"]:
            for source in (target / "wasm32-wasip1" / profile / "deps").glob(f"libpanic_abort-*.{suffix}"):
                destination = libdir / source.name
                if not destination.exists() or destination.read_bytes() != source.read_bytes():
                    shutil.copyfile(source, destination)
                    changed = True
    return changed


_ANSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")
_MISSING_RUNTIME = re.compile(rb"(?:can't|cannot|could not) find crate (?:for )?[`'\"]panic_abort[`'\"]")


def _run_cargo(command: list[str]) -> tuple[int, bool]:
    missing_runtime = False
    other_error = False
    with subprocess.Popen(command, stderr=subprocess.PIPE) as process:
        assert process.stderr is not None
        for line in process.stderr:
            binary_stderr = getattr(sys.stderr, "buffer", None)
            if binary_stderr is not None:
                binary_stderr.write(line)
            else:
                sys.stderr.write(line.decode("utf-8", errors="replace"))
            sys.stderr.flush()
            diagnostic = _ANSI.sub(b"", line).strip().lower()
            if re.match(rb"error(?:\[[^]]+\])?:", diagnostic):
                if _MISSING_RUNTIME.search(diagnostic):
                    missing_runtime = True
                elif not diagnostic.startswith((
                        b"error: could not compile ", b"error: aborting due to ", b"error: build failed")):
                    other_error = True
        return process.wait(), missing_runtime and not other_error


def main(args: list[str]) -> int:
    sysroot = Path(os.environ["SIGNALBOX_WASI_RUST_SYSROOT"]).resolve()
    rustup_home = Path(os.environ["RUSTUP_HOME"]).resolve()
    if not sysroot.is_relative_to(rustup_home):
        raise ValueError("refusing panic runtime placement outside wrapper RUSTUP_HOME")
    target = Path(os.environ["CARGO_TARGET_DIR"])
    command = [os.environ["SIGNALBOX_WASI_RUSTUP"], "run", os.environ["RUSTUP_TOOLCHAIN"], "cargo", *args]
    libdir = sysroot / "lib/rustlib/wasm32-wasip1/lib"
    with (rustup_home / ".cargo-wasi.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        place_panic_runtime(target, libdir)
        code, missing_runtime = _run_cargo(command)
        if code and missing_runtime and place_panic_runtime(target, libdir):
            code, _ = _run_cargo(command)
        return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
