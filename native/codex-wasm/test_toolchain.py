import hashlib
import io
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import toolchain
from dependencies import cargo, staging, wasi


def archive_bytes(files: dict[str, bytes]) -> bytes:
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w:gz") as archive:
        for name, contents in files.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(contents)
            archive.addfile(entry, io.BytesIO(contents))
    return data.getvalue()


def git(root: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


class DependencyPreparationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.cache = self.root / "cache"
        self.repo = self.cache / "sources/reference"
        self.repo.mkdir(parents=True)
        git(self.repo, "init", "--quiet")
        for directory, name in [
            ("codex-rs/vendor/tokio-wasi", "tokio"),
            ("toolchain/stubs/reqwest-shim", "reqwest"),
            ("toolchain/stubs/portable-pty-wasi", "portable-pty"),
            ("toolchain/stubs/ctrlc", "ctrlc"),
            ("toolchain/crates/libs/wasi-http", "agentos-wasi-http"),
            ("toolchain/crates/libs/wasi-spawn", "agentos-wasi-spawn"),
            ("toolchain/crates/libs/wasi-pty", "agentos-wasi-pty"),
            ("toolchain/crates/wasi-ext", "wasi-ext"),
        ]:
            path = self.repo / directory / "Cargo.toml"
            path.parent.mkdir(parents=True)
            path.write_text(f'[package]\nname = "{name}"\nversion = "1.0.0"\n')
        git(self.repo, "add", ".")
        git(self.repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@local",
            "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture")
        self.revision = git(self.repo, "rev-parse", "HEAD")
        self.assets = self.root / "assets"
        (self.assets / "patches").mkdir(parents=True)
        (self.assets / "patches/wasi-deps.patch").write_text(
            '--- a/patched/example-1.0.0/Cargo.toml\n'
            '+++ b/patched/example-1.0.0/Cargo.toml\n'
            '@@ -1,3 +1,4 @@\n [package]\n name = "example"\n version = "1.0.0"\n'
            '+description = "WASI fixture"\n')
        data = archive_bytes({"example-1.0.0/Cargo.toml": b'[package]\nname = "example"\nversion = "1.0.0"\n'})
        self.crate = self.root / "example.crate"
        self.crate.write_bytes(data)
        self.crates = {"example": ("1.0.0", hashlib.sha256(data).hexdigest())}
        self.sources = dict.fromkeys(["agentos", "rivet-codex", "codex-wasi-agentos"], self.repo)
        for name, value in [("AGENTOS", self.revision), ("RIVET_CODEX", self.revision),
                            ("ASSETS", self.assets), ("CRATES", self.crates)]:
            self.enterContext(patch.object(toolchain, name, value))
        self.network = self.enterContext(patch("urllib.request.urlopen", side_effect=lambda *a, **k: self.crate.open("rb")))

    def test_stages_patched_independent_absolute_paths_and_reuses_cache(self):
        before = {str(p.relative_to(self.repo)): p.read_bytes() for p in self.repo.rglob("*") if p.is_file()}
        paths = toolchain.prepare_dependencies(self.cache, self.sources)
        self.assertEqual(set(paths), {"tokio", "reqwest", "portable-pty", "ctrlc", "example"})
        self.assertTrue(all(path.is_absolute() and path.is_relative_to(self.cache.resolve()) for path in paths.values()))
        self.assertIn('description = "WASI fixture"', (paths["example"] / "Cargo.toml").read_text())
        paths["tokio"].joinpath("Cargo.toml").write_text('[package]\nname="tokio"\nversion="2.0.0"\n')
        self.assertEqual(before, {str(p.relative_to(self.repo)): p.read_bytes() for p in self.repo.rglob("*") if p.is_file()})
        self.network.side_effect = AssertionError("cache reuse must not download")
        self.assertEqual(paths, toolchain.prepare_dependencies(self.cache, self.sources))
        self.assertEqual(self.network.call_count, 1)

    def test_no_checkout_repository_is_read_by_archive(self):
        # Leave Git objects/index intact but remove all checked-out source files.
        for path in self.repo.iterdir():
            if path.name != ".git":
                shutil.rmtree(path)
        paths = toolchain.prepare_dependencies(self.cache, self.sources)
        self.assertTrue((paths["tokio"] / "Cargo.toml").is_file())
        self.assertEqual([".git"], [p.name for p in self.repo.iterdir()])

    def test_bad_download_does_not_publish_or_keep_partial_archive(self):
        self.crate.write_bytes(b"corrupt download")
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            toolchain.prepare_dependencies(self.cache, self.sources)
        self.assertFalse(list(self.cache.glob("wasi-deps-*")))
        self.assertFalse(list(self.cache.rglob("*.partial")))
        self.assertFalse((self.cache / "downloads/example-1.0.0.crate").exists())

    def test_patch_failure_does_not_publish_stage(self):
        (self.assets / "patches/wasi-deps.patch").write_text('--- a/missing\n+++ b/missing\n@@ -1 +1 @@\n-old\n+new\n')
        with self.assertRaises(subprocess.CalledProcessError):
            toolchain.prepare_dependencies(self.cache, self.sources)
        self.assertFalse(list(self.cache.glob("wasi-deps-*")))
        self.assertFalse(list(self.cache.glob(".wasi-deps-*")))

    def test_cache_inside_source_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "inside a source"):
            toolchain.prepare_dependencies(self.repo / "build", self.sources)
        self.assertFalse((self.repo / "build").exists())


class ArchiveTests(unittest.TestCase):
    def test_traversal_and_escaping_symlinks_are_rejected(self):
        for name, link in [("../outside", None), ("bad", "../outside")]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                data = io.BytesIO()
                with tarfile.open(fileobj=data, mode="w") as archive:
                    entry = tarfile.TarInfo(name)
                    if link:
                        entry.type, entry.linkname = tarfile.SYMTYPE, link
                    archive.addfile(entry)
                data.seek(0)
                with tarfile.open(fileobj=data) as archive, self.assertRaises(ValueError):
                    staging.extract(archive, Path(temporary) / "stage")

    def test_corrupt_cached_download_is_rejected_without_network(self):
        with tempfile.TemporaryDirectory() as temporary, patch("urllib.request.urlopen") as network:
            file = Path(temporary) / "cached.crate"
            file.write_bytes(b"bad")
            with self.assertRaisesRegex(ValueError, "cached"):
                staging.download("https://example.test/crate", file, "0" * 64)
            network.assert_not_called()


class CargoLauncherTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.sysroot = self.root / "rustup/toolchains/nightly"
        self.libdir = self.sysroot / "lib/rustlib/wasm32-wasip1/lib"
        self.libdir.mkdir(parents=True)
        self.target = self.root / "target"
        self.enterContext(patch.dict(os.environ, {
            "RUSTUP_HOME": str(self.root / "rustup"), "SIGNALBOX_WASI_RUST_SYSROOT": str(self.sysroot),
            "CARGO_TARGET_DIR": str(self.target), "SIGNALBOX_WASI_RUSTUP": "/fixture/rustup",
            "RUSTUP_TOOLCHAIN": wasi.NIGHTLY,
        }))

    def test_stderr_is_forwarded_and_retry_requires_only_missing_runtime_errors(self):
        missing = b"error[E0463]: can't find crate for `panic_abort`\n"
        unrelated = b"error[E0599]: no method named set_no_sigpipe found\n"
        summary = b"error: could not compile `engine` due to 1 previous error\n"
        for diagnostic, expected in [
            (b"    Checking engine\n\x1b[31m" + missing + b"\x1b[0m" + summary, True),
            (unrelated + b"note: build-std produced panic_abort\n", False),
            (missing + unrelated + summary, False),
            (b"note: " + missing + summary, False),
            (b"progress with an invalid byte: \xff\n", False),
        ]:
            with self.subTest(diagnostic=diagnostic):
                output = io.BytesIO()
                stderr = io.TextIOWrapper(output, encoding="utf-8")
                command = [sys.executable, "-c", f"import os; os.write(2, {diagnostic!r}); raise SystemExit(1)"]
                with patch("dependencies.cargo.sys.stderr", stderr):
                    code, retry = cargo._run_cargo(command)
                self.assertEqual(1, code)
                self.assertEqual(expected, retry)
                self.assertEqual(diagnostic, output.getvalue())

    def test_compile_error_with_new_runtime_is_not_retried(self):
        program = self.root / "fake-rustup"
        program.write_text("#!" + sys.executable + "\n" +
            "import os, pathlib\n"
            "target = pathlib.Path(os.environ['CARGO_TARGET_DIR'])\n"
            "target.mkdir(parents=True, exist_ok=True)\n"
            "attempts = target / 'attempts'\n"
            "attempts.write_text(attempts.read_text() + 'attempt\\n' if attempts.exists() else 'attempt\\n')\n"
            "deps = target / 'wasm32-wasip1/release/deps'\n"
            "deps.mkdir(parents=True, exist_ok=True)\n"
            "(deps / 'libpanic_abort-fresh.rlib').write_bytes(b'new runtime')\n"
            "os.write(2, b'    Checking socket2 v0.6.3\\nerror[E0599]: no method named set_no_sigpipe found\\n')\n"
            "raise SystemExit(1)\n")
        program.chmod(0o755)
        with patch.dict(os.environ, {"SIGNALBOX_WASI_RUSTUP": str(program)}):
            self.assertEqual(1, cargo.main(["check"]))
        self.assertTrue((self.target / "wasm32-wasip1/release/deps/libpanic_abort-fresh.rlib").is_file())
        self.assertEqual(["attempt"], (self.target / "attempts").read_text().splitlines())

    def test_missing_runtime_retries_once_only_after_new_runtime_is_copied(self):
        def compile(command):
            self.assertEqual(command[:5], ["/fixture/rustup", "run", wasi.NIGHTLY, "cargo", "build"])
            directory = self.target / "wasm32-wasip1/release/deps"
            directory.mkdir(parents=True, exist_ok=True)
            (directory / "libpanic_abort-test.rlib").write_bytes(b"runtime")
            return 1, True
        with patch("dependencies.cargo._run_cargo", side_effect=compile) as run:
            self.assertEqual(1, cargo.main(["build", "--release"]))
        self.assertEqual(run.call_count, 2)
        self.assertEqual(b"runtime", (self.libdir / "libpanic_abort-test.rlib").read_bytes())

    def test_failure_without_new_runtime_is_not_retried(self):
        with patch("dependencies.cargo._run_cargo", return_value=(7, True)) as run:
            self.assertEqual(7, cargo.main(["build"]))
        self.assertEqual(run.call_count, 1)

    def test_shared_sysroot_is_rejected_before_running_cargo(self):
        with patch.dict(os.environ, {"SIGNALBOX_WASI_RUST_SYSROOT": str(self.root / "global-rustup")}), \
                patch("dependencies.cargo._run_cargo") as run, self.assertRaisesRegex(ValueError, "outside"):
            cargo.main(["build"])
        run.assert_not_called()


class LibcBoundaryTests(unittest.TestCase):
    def test_ignored_parent_cache_needs_its_own_git_repository(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            git(parent, "init", "--quiet")
            (parent / ".gitignore").write_text("ignored/\n")
            root = parent / "ignored/preparation"
            libc = root / "wasi-libc"
            libc.mkdir(parents=True)
            (libc / "Makefile").write_text("fixture")
            (libc / "header").write_text("before\n")
            patches = root / "toolchain/std-patches/wasi-libc"
            patches.mkdir(parents=True)
            (patches / "0001.patch").write_text(
                "diff --git a/libc-bottom-half/sources/host_spawn_wait.c b/libc-bottom-half/sources/host_spawn_wait.c\n"
                "new file mode 100644\n--- /dev/null\n+++ b/libc-bottom-half/sources/host_spawn_wait.c\n"
                "@@ -0,0 +1 @@\n+pid_t wait(int *status) { return 0; }\n")
            (patches / "0002.patch").write_text("--- a/header\n+++ b/header\n@@ -1 +1 @@\n-before\n+after\n")
            tools = parent / "tools"
            tools.mkdir()
            (tools / "make").write_text("#!/bin/sh\nexit 23\n")
            (tools / "make").chmod(0o755)
            env = {**os.environ, "CL": str(root), "AOS_TC": str(root / "toolchain"),
                   "WASI_SDK_DIR": str(root / "sdk"), "PATH": str(tools) + os.pathsep + os.environ["PATH"]}
            script = staging.ASSETS / "build-wasi-libc.sh"
            old = parent / "old.sh"
            old.write_text(script.read_text().replace('git -C "$SRC" init --quiet', "true"))
            failed = subprocess.run(["bash", str(old)], env=env, capture_output=True, text=True)
            self.assertNotEqual(23, failed.returncode)
            self.assertFalse((libc / "libc-bottom-half/sources/host_spawn_wait.c").exists())
            # A failed series can partly mutate files; preparation re-archives libc.
            (libc / "header").write_text("before\n")
            fixed = subprocess.run(["bash", str(script)], env=env, capture_output=True, text=True)
            self.assertEqual(23, fixed.returncode, fixed.stdout + fixed.stderr)
            self.assertEqual("after\n", (libc / "header").read_text())
            self.assertTrue((libc / "libc-bottom-half/sources/host_spawn_wait.c").is_file())
            self.assertEqual(str(libc.resolve()), git(libc, "rev-parse", "--show-toplevel"))


class ToolchainEnvironmentTests(unittest.TestCase):
    def test_preparation_patches_only_private_rust_and_reuses_complete_install(self):
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary).resolve() / "cache"
            assets = Path(temporary) / "assets"
            (assets / "patches/std").mkdir(parents=True)
            (assets / "build-wasi-libc.sh").write_text("fixture\nmake -C source\n")
            (assets / "cargo.py").write_text("fixture")
            (assets / "patches/std/extra.patch").write_text(
                '--- a/note\n+++ b/note\n@@ -1 +1 @@\n-agentos\n+extra\n')
            installed = []
            fail_libc = [True]

            def run(args, **kwargs):
                command = [str(arg) for arg in args]
                env = kwargs.get("env", {})
                if command[1:3] == ["toolchain", "install"]:
                    home = Path(env["RUSTUP_HOME"])
                    self.assertTrue(home.is_relative_to(cache))
                    self.assertTrue(Path(env["CARGO_HOME"]).is_relative_to(cache))
                    sysroot = home / "toolchains/nightly"
                    (sysroot / "lib/rustlib/src/rust/library/std").mkdir(parents=True)
                    (sysroot / "lib/rustlib/src/rust/note").write_text("pristine\n")
                    libdir = sysroot / "lib/rustlib/wasm32-wasip1/lib"
                    libdir.mkdir(parents=True)
                    (libdir / "libstd-prebuilt.rlib").write_bytes(b"prebuilt")
                    installed.append(sysroot)
                elif "--print" in command:
                    return subprocess.CompletedProcess(command, 0, str(installed[-1]))
                elif command[0] == "bash":
                    if fail_libc[0]:
                        fail_libc[0] = False
                        raise subprocess.CalledProcessError(1, command)
                    root = Path(env["CL"])
                    self.assertEqual("extra\n", (installed[-1] / "lib/rustlib/src/rust/note").read_text())
                    output = root / "sysroot/lib/wasm32-wasi"
                    output.mkdir(parents=True)
                    for name in ["libc.a", "crt1-command.o", "libwasi-emulated-pthread.a", "libwasi-emulated-signal.a",
                                 "libwasi-emulated-mman.a", "libwasi-emulated-process-clocks.a"]:
                        (output / name).write_bytes(b"output")
                return subprocess.CompletedProcess(command, 0)

            def archive(repo, revision, paths, destination):
                if revision == wasi.AGENTOS:
                    patches = destination / "toolchain/std-patches"
                    patches.mkdir(parents=True)
                    (patches / "first.patch").write_text(
                        '--- a/note\n+++ b/note\n@@ -1 +1 @@\n-pristine\n+agentos\n')
                    (patches / "companion").write_text("companion")
                    (patches / "copy.manifest").write_text("companion library/std/companion\n")
                else:
                    destination.mkdir(parents=True)
                    (destination / "Makefile").write_text("fixture")

            sdk = Path(temporary) / "sdk.tar.gz"
            sdk.write_bytes(archive_bytes({f"{wasi._sdk_name()}/bin/clang": b"fixture"}))
            with patch.object(wasi, "ASSETS", assets), patch.object(wasi, "run", side_effect=run) as commands, \
                    patch.object(wasi, "git_archive", side_effect=archive), \
                    patch.object(wasi, "download", return_value=sdk) as network, \
                    patch.object(wasi.shutil, "which", return_value="/fixture/rustup"):
                sources = {"agentos": Path(temporary) / "source"}
                with self.assertRaises(subprocess.CalledProcessError):
                    toolchain.prepare_wasi_toolchain(cache, sources)
                env = toolchain.prepare_wasi_toolchain(cache, sources)
                self.assertEqual(len(installed), 1, "libc retry must preserve patched Rust")
                count = commands.call_count
                prepared = Path(env["CARGO"]).parent
                legacy_identity = wasi._legacy_identity(prepared)
                self.assertIsNotNone(legacy_identity)
                assert legacy_identity is not None
                (prepared / ".ready").write_text(legacy_identity)
                (assets / "cargo.py").write_text("updated launcher")
                script = assets / "build-wasi-libc.sh"
                script.write_text(script.read_text().replace("make -C", "make -s -C"))
                self.assertEqual(env, toolchain.prepare_wasi_toolchain(cache, sources))
                self.assertEqual(commands.call_count, count, "launcher/quiet changes must reuse completed libc")
                self.assertEqual("updated launcher", (prepared / "cargo.py").read_text())
                self.assertEqual(wasi._identity(), (prepared / ".ready").read_text())
                network.assert_called_once()
            self.assertTrue(Path(env["CARGO"]).stat().st_mode & 0o111)
            self.assertTrue(Path(env["RUSTC"]).is_relative_to(cache))
            self.assertFalse(list(installed[-1].rglob("libstd-prebuilt.rlib")))
            self.assertEqual("companion", (installed[-1] / "lib/rustlib/src/rust/library/std/companion").read_text())

    def test_paths_and_encoded_link_flags_survive_spaces(self):
        with tempfile.TemporaryDirectory(prefix="wasi with spaces ") as temporary:
            root = Path(temporary)
            lib = root / "sysroot/lib/wasm32-wasi"
            lib.mkdir(parents=True)
            (lib / "libc.a").write_bytes(b"libc")
            env = wasi._environment(root, "/usr/bin/rustup")
            self.assertEqual(env["RUSTUP_HOME"], str(root / "rustup"))
            self.assertEqual(env["CARGO_HOME"], str(root / "cargo-home"))
            self.assertEqual(env["CARGO"], str(root / "cargo-wasi"))
            self.assertIn(f"link-arg={lib / 'libc.a'}", env["CARGO_ENCODED_RUSTFLAGS"].split("\x1f"))

    def test_missing_rustup_does_not_install_or_mutate_global_state(self):
        with tempfile.TemporaryDirectory() as temporary, patch("dependencies.wasi.shutil.which", return_value=None), \
                patch("dependencies.wasi.run") as run, self.assertRaisesRegex(RuntimeError, "rustup executable"):
            toolchain.prepare_wasi_toolchain(Path(temporary) / "cache", {})
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
