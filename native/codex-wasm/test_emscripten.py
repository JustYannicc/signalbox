# pyright: reportImplicitRelativeImport=false, reportUninitializedInstanceVariable=false

from contextlib import ExitStack
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import emscripten


class EmscriptenPreparationTests(unittest.TestCase):
    def setUp(self):
        contexts = ExitStack()
        self.addCleanup(contexts.close)
        self.temporary = tempfile.TemporaryDirectory(prefix="emsdk with spaces ")
        self.addCleanup(self.temporary.cleanup)
        self.cache = Path(self.temporary.name).resolve()
        self.sdk = self.cache / f"emsdk-{emscripten.SDK_VERSION}-{emscripten.EMSDK_COMMIT[:12]}"
        rustup = self.cache / "rust/rustup"
        rustbin = rustup / "toolchains/nightly/bin"
        rustbin.mkdir(parents=True)
        (rustbin / "rustc").write_text("unchanged Rust")
        (rustbin / "cargo").write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
        (rustbin / "cargo").chmod(0o755)
        self.base = {
            "RUSTUP_HOME": str(rustup), "CARGO_HOME": str(self.cache / "rust/cargo"),
            "RUSTC": str(rustbin / "rustc"), "RUSTUP_TOOLCHAIN": emscripten.NIGHTLY,
            "CARGO": str(self.cache / "rust/cargo-wasi"),
            "CARGO_ENCODED_RUSTFLAGS": "-C\x1flink-arg=/wasi/libc.a",
            "RUSTFLAGS": "--sysroot /wasi", "CARGO_BUILD_RUSTFLAGS": "--cfg wasi",
            "LDFLAGS": "/wasi/crt1-command.o", "CFLAGS": "--sysroot=/wasi",
            "EM_CONFIG": "/global/.emscripten", "EM_CACHE": "/global/em-cache",
            "EMSDK_NODE": "/global/node", "EMCC_CFLAGS": "-pthread",
        }
        self.archive = self.cache / "fixture.tar.gz"
        with tarfile.open(self.archive, "w:gz") as archive:
            for name, data in {
                "emsdk.py": b"fixture",
                "emscripten-releases-tags.json": json.dumps({
                    "releases": {emscripten.SDK_VERSION: emscripten.SDK_RELEASE},
                }).encode(),
            }.items():
                entry = tarfile.TarInfo(f"emsdk-{emscripten.EMSDK_COMMIT}/{name}")
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
        self.operations = []
        self.fail_install = False
        self.version = emscripten.SDK_VERSION
        contexts.enter_context(patch.object(emscripten.platform, "system", return_value="Darwin"))
        contexts.enter_context(patch.object(emscripten.platform, "machine", return_value="arm64"))
        self.network = contexts.enter_context(patch.object(emscripten, "download", return_value=self.archive))
        self.commands = contexts.enter_context(patch.object(emscripten, "run", side_effect=self.run_command))

    def run_command(self, args, **kwargs):
        command = [str(arg) for arg in args]
        env = kwargs["env"]
        for key in ("EMSDK", "EM_CONFIG", "EM_CACHE", "TMPDIR", "npm_config_cache",
                    "npm_config_prefix", "npm_config_userconfig", "npm_config_globalconfig"):
            self.assertTrue(Path(env[key]).is_relative_to(self.sdk), (key, env[key]))
        self.assertNotIn("EMCC_CFLAGS", env)
        if command[1:2] == [str(self.sdk / "emsdk.py")]:
            operation = command[2]
            self.operations.append(operation)
            self.assertEqual(command[3], emscripten.SDK_VERSION)
            if operation == "install":
                if self.fail_install:
                    raise subprocess.CalledProcessError(1, command)
                for path in ("node/bin/node", "upstream/bin/clang", "upstream/bin/wasm-opt",
                             "upstream/emscripten/emcc", "upstream/emscripten/em++", "upstream/emscripten/emar"):
                    target = self.sdk / path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text("sdk fixture")
            elif operation == "activate":
                (self.sdk / ".emscripten").write_text("official embedded configuration fixture")
            return subprocess.CompletedProcess(command, 0)
        if command[1:2] == ["-c"]:
            return subprocess.CompletedProcess(command, 0, json.dumps({
                "LLVM_ROOT": str(self.sdk / "upstream/bin"),
                "BINARYEN_ROOT": str(self.sdk / "upstream"),
                "NODE_JS": [str(self.sdk / "node/bin/node")],
            }))
        if command[-1] == "--version":
            return subprocess.CompletedProcess(command, 0, f"emcc (fixture) {self.version}\n")
        self.fail(f"unexpected command {command}")

    def test_isolates_sdk_reuses_rust_and_removes_wasi_flags(self):
        before = dict(self.base)
        process_before = dict(os.environ)
        env = emscripten.prepare_emscripten_toolchain(self.cache, self.base)
        self.assertEqual(before, self.base)
        self.assertEqual(process_before, dict(os.environ))
        for key in ("RUSTUP_HOME", "CARGO_HOME", "RUSTC", "RUSTUP_TOOLCHAIN"):
            self.assertEqual(env[key], self.base[key])
        self.assertEqual("unchanged Rust", Path(env["RUSTC"]).read_text())
        self.assertNotIn("/wasi", env["CARGO_ENCODED_RUSTFLAGS"])
        self.assertNotIn("-pthread", env["CARGO_ENCODED_RUSTFLAGS"])
        for key in ("RUSTFLAGS", "CARGO_BUILD_RUSTFLAGS", "LDFLAGS", "CFLAGS", "EMCC_CFLAGS"):
            self.assertEqual("", env[key])
        self.assertIn("link-arg=-sJSPI=1", env["CARGO_ENCODED_RUSTFLAGS"].split("\x1f"))
        self.assertIn(f"link-arg=--js-library={emscripten.LINK_LIBRARY}",
                      env["CARGO_ENCODED_RUSTFLAGS"].split("\x1f"))
        self.assertEqual(env["CARGO_ENCODED_RUSTFLAGS"].split("\x1f").count(
            f"link-arg=--js-library={emscripten.HTTP_LINK_LIBRARY}"), 1)
        self.assertTrue(Path(env["CARGO_TARGET_DIR"]).is_relative_to(self.cache))
        self.assertEqual(str(self.sdk), env["PATH"].split(os.pathsep)[0])
        self.assertTrue(Path(env["CC_wasm32_unknown_emscripten"]).is_file())
        self.assertTrue(Path(env["CXX_wasm32_unknown_emscripten"]).is_file())
        self.assertTrue(Path(env["AR_wasm32_unknown_emscripten"]).is_file())
        self.assertEqual(["install", "activate"], self.operations)
        self.assertEqual(emscripten.EMSDK_ARCHIVE_SHA256, self.network.call_args.args[2])
        # Execute the actual launcher, including a path containing whitespace.
        arguments = ["metadata", "--manifest-path", "/fixture with spaces/Cargo.toml"]
        result = subprocess.check_output([env["CARGO"], *arguments], env=env, text=True)
        self.assertEqual(arguments, result.splitlines())
        self.assertEqual(env, emscripten.prepare_emscripten_toolchain(self.cache, self.base))
        self.assertEqual(["install", "activate"], self.operations)
        self.network.assert_called_once()

    def test_failed_install_is_not_marked_ready_and_can_resume(self):
        self.fail_install = True
        with self.assertRaises(subprocess.CalledProcessError):
            emscripten.prepare_emscripten_toolchain(self.cache, self.base)
        self.assertFalse((self.sdk / ".ready").exists())
        self.fail_install = False
        emscripten.prepare_emscripten_toolchain(self.cache, self.base)
        self.assertEqual(["install", "install", "activate"], self.operations)
        self.network.assert_called_once()

    def test_wrong_compiler_version_never_marks_sdk_ready(self):
        self.version = "4.0.11"
        with self.assertRaisesRegex(ValueError, "activated emcc is not"):
            emscripten.prepare_emscripten_toolchain(self.cache, self.base)
        self.assertFalse((self.sdk / ".ready").exists())

    def test_rejects_external_rust_before_download_or_install(self):
        for key in ("RUSTUP_HOME", "CARGO_HOME", "RUSTC"):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "outside wrapper cache"):
                emscripten.prepare_emscripten_toolchain(self.cache, {**self.base, key: "/global/rust"})
        self.network.assert_not_called()
        self.commands.assert_not_called()

    def test_wrong_nightly_and_symlinked_sdk_fail_without_installing(self):
        with self.assertRaisesRegex(ValueError, "nightly-2026-03-01"):
            emscripten.prepare_emscripten_toolchain(self.cache, {**self.base, "RUSTUP_TOOLCHAIN": "stable"})
        external = self.cache / "elsewhere"
        external.mkdir()
        self.sdk.symlink_to(external, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            emscripten.prepare_emscripten_toolchain(self.cache, self.base)
        self.network.assert_not_called()
        self.commands.assert_not_called()


class EmscriptenLoaderTests(unittest.TestCase):
    def test_precompiled_loader_and_jspi_contract(self):
        root = Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory() as temporary:
            stage = Path(temporary)
            shutil.copyfile(root / "loader-emscripten.mjs", stage / "loader-emscripten.mjs")
            shutil.copyfile(root / "emscripten/loader.test.mjs", stage / "loader.test.mjs")
            shutil.copyfile(root / "emscripten/factory-fixture.mjs", stage / "engine.mjs")
            subprocess.run(["node", "--experimental-wasm-jspi", "--test", stage / "loader.test.mjs"], check=True)


if __name__ == "__main__":
    unittest.main()
