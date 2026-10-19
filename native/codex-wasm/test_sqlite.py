# pyright: reportImplicitRelativeImport=false
# pyright: reportUninitializedInstanceVariable=false

import hashlib
import io
import importlib.util
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
from typing import Optional
from unittest.mock import Mock, patch

import sqlite as staging


ASSETS = Path(__file__).resolve().parent / "sqlite"


class SqliteStagingTests(unittest.TestCase):
    root: Path
    cache: Path
    source: Path
    tokio: Path
    other: Path
    base: dict[str, Path]
    assets: Path
    archive: bytes
    expected_checksum: str
    download: Mock

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="sqlite-stage-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.cache = self.root / "cache"
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "sentinel").write_text("original source")

        self.tokio = self.root / "base" / "tokio"
        self.tokio.mkdir(parents=True)
        (self.tokio / "Cargo.toml").write_text('[package]\nname = "tokio"\nversion = "1.52.3"\n')
        (self.tokio / "src.rs").write_text("original Tokio input\n")
        self.other = self.root / "base" / "socket2"
        self.other.mkdir()
        self.base = {"tokio": self.tokio, "socket2": self.other}

        self.assets = self.root / "assets"
        self.assets.mkdir()
        shutil.copyfile(ASSETS / "sqlx-worker.patch", self.assets / "sqlx-worker.patch")
        shutil.copyfile(ASSETS / "worker_wasi.rs", self.assets / "worker_wasi.rs")
        self.archive = self._make_archive()
        self.expected_checksum = hashlib.sha256(self.archive).hexdigest()

        assets_patch = patch.object(staging, "ASSETS", self.assets)
        assets_patch.start()
        self.addCleanup(assets_patch.stop)
        crate_patch = patch.object(staging, "SQLX_SQLITE", ("0.9.0", self.expected_checksum))
        crate_patch.start()
        self.addCleanup(crate_patch.stop)
        download_patch = patch.object(staging, "download", side_effect=self._download)
        self.download = download_patch.start()
        self.addCleanup(download_patch.stop)

    def _make_archive(self) -> bytes:
        cargo_lines = [
            "[package]",
            'name = "sqlx-sqlite"',
            'version = "0.9.0"',
            'license = "MIT OR Apache-2.0"',
        ]
        cargo_lines.extend(f"# fixture line {line}" for line in range(5, 195))
        cargo_lines.extend([
            "[lints.clippy]",
            'cast_possible_wrap = "deny"',
            'cast_sign_loss = "deny"',
            'disallowed_methods = "deny"',
        ])
        connection_lines = [f"// fixture line {line}" for line in range(1, 47)]
        connection_lines.append("mod worker;")
        files = {
            "sqlx-sqlite-0.9.0/Cargo.toml": ("\n".join(cargo_lines) + "\n").encode(),
            "sqlx-sqlite-0.9.0/src/connection/mod.rs": (
                "\n".join(connection_lines) + "\n"
            ).encode(),
            "sqlx-sqlite-0.9.0/src/connection/worker.rs": b"upstream worker source\n",
            "sqlx-sqlite-0.9.0/LICENSE-MIT": b"upstream MIT license\n",
            "sqlx-sqlite-0.9.0/LICENSE-APACHE": b"upstream Apache license\n",
        }
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            for name, data in files.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
        return buffer.getvalue()

    def _download(self, url: str, destination: Path, checksum: str) -> Path:
        if hashlib.sha256(self.archive).hexdigest() != checksum:
            raise ValueError(f"SHA-256 mismatch for {url}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(self.archive)
        return destination

    def prepare(
        self,
        cache: Optional[Path] = None,
        base_patches: Optional[dict[str, Path]] = None,
    ):
        return staging.prepare_sqlite_dependencies(
            self.cache if cache is None else cache,
            {"codex": self.source},
            self.base if base_patches is None else base_patches,
        )

    def test_applies_small_patch_and_copies_one_worker_asset_into_complete_map(self):
        tokio_input = (self.tokio / "src.rs").read_bytes()
        paths = self.prepare()
        self.assertIsNot(paths, self.base)
        self.assertEqual(set(paths), {"tokio", "socket2", "sqlx-sqlite"})
        self.assertIs(paths["tokio"], self.tokio)
        self.assertIs(paths["socket2"], self.other)
        crate = paths["sqlx-sqlite"]
        self.assertTrue(crate.is_relative_to(self.cache.resolve()))
        self.assertIn("target.'cfg(all(target_os = \"wasi\", target_env = \"p1\", not(target_feature = \"atomics\")))'.dependencies",
                      (crate / "Cargo.toml").read_text())
        self.assertIn("#[path = \"worker_wasi.rs\"]", (crate / "src/connection/mod.rs").read_text())
        self.assertEqual(
            (crate / "src/connection/worker_wasi.rs").read_bytes(),
            (self.assets / "worker_wasi.rs").read_bytes(),
        )
        self.assertEqual((crate / "LICENSE-MIT").read_bytes(), b"upstream MIT license\n")
        self.assertEqual((crate / "LICENSE-APACHE").read_bytes(), b"upstream Apache license\n")
        self.assertEqual((self.tokio / "src.rs").read_bytes(), tokio_input)
        self.assertEqual((self.source / "sentinel").read_text(), "original source")
        self.assertEqual(self.download.call_count, 1)

    def test_reuse_verifies_ready_inventory_before_returning_cached_map(self):
        paths = self.prepare()
        self.download.side_effect = AssertionError("cache reuse must not download")
        self.assertEqual(self.prepare(), paths)

        worker = paths["sqlx-sqlite"] / "src/connection/worker_wasi.rs"
        original = worker.read_bytes()
        worker.write_bytes(original + b"tampered")
        with self.assertRaisesRegex(ValueError, "cache changed"):
            self.prepare()

    def test_asset_bytes_change_stage_identity(self):
        first = self.prepare()
        asset = self.assets / "worker_wasi.rs"
        asset.write_text(asset.read_text() + "\n// reviewed target-specific adjustment\n")
        second = self.prepare()
        self.assertNotEqual(first["sqlx-sqlite"], second["sqlx-sqlite"])
        self.assertEqual(
            (second["sqlx-sqlite"] / "src/connection/worker_wasi.rs").read_bytes(),
            asset.read_bytes(),
        )

    def test_bad_archive_checksum_never_publishes_a_stage(self):
        self.archive += b"corruption"
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            self.prepare()
        self.assertEqual(list(self.cache.glob("sqlite-sqlx-*")), [])
        self.assertEqual(list(self.cache.glob(".sqlite-sqlx-*")), [])

    def test_wrong_tokio_version_and_missing_tokio_fail_before_download(self):
        manifest = self.tokio / "Cargo.toml"
        original = manifest.read_text()
        manifest.write_text(original.replace("1.52.3", "1.52.4"))
        with self.assertRaisesRegex(ValueError, "expected tokio 1.52.3"):
            self.prepare()
        manifest.write_text(original)
        with self.assertRaisesRegex(ValueError, "requires the existing Tokio patch"):
            self.prepare(base_patches={"socket2": self.other})
        self.download.assert_not_called()

    def test_cache_must_not_overlap_inputs_or_be_a_symlink(self):
        with self.assertRaisesRegex(ValueError, "overlaps source:codex"):
            self.prepare(self.source / "cache")
        with self.assertRaisesRegex(ValueError, "overlaps base:tokio"):
            self.prepare(self.tokio / "cache")
        link = self.root / "cache-link"
        link.symlink_to(self.cache, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "must not be a symlink"):
            self.prepare(link)
        self.download.assert_not_called()

    def test_symlinked_ready_marker_fails_closed(self):
        paths = self.prepare()
        root = paths["sqlx-sqlite"].parent
        marker = root / ".ready"
        target = root / "ready-copy"
        marker.rename(target)
        marker.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "regular ready marker"):
            self.prepare()

    def test_unexpected_patch_file_scope_fails_before_download(self):
        patch_file = self.assets / "sqlx-worker.patch"
        patch_file.write_text(patch_file.read_text() + "--- a/sqlx-sqlite/src/connection/extra.rs\n")
        with self.assertRaisesRegex(ValueError, "unexpected file scope"):
            self.prepare()
        self.download.assert_not_called()


class SqliteProbeOutputTests(unittest.TestCase):
    def test_input_overlap_is_rejected_before_any_probe_setup(self):
        spec = importlib.util.spec_from_file_location("sqlite_probe", ASSETS / "build_probe.py")
        assert spec is not None and spec.loader is not None
        probe = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(probe)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            wrapper, cache, lockfile = root / "wrapper", root / "cache", root / "release/Cargo.lock"
            for output in (wrapper / "out", cache / "out", lockfile, root):
                argv = ["build_probe.py", "--output", str(output), "--cache", str(cache),
                        "--lockfile", str(lockfile)]
                with self.subTest(output=output), patch.object(probe, "WRAPPER", wrapper), \
                        patch.object(probe.sys, "argv", argv), patch.object(probe, "_ready_root") as setup:
                    with self.assertRaisesRegex(ValueError, "probe output overlaps an input"):
                        probe.main()
                    setup.assert_not_called()
            output = root / "probe"
            argv = ["build_probe.py", "--output", str(output), "--cache", str(cache),
                    "--lockfile", str(lockfile)]
            with patch.object(probe, "WRAPPER", wrapper), patch.object(probe.sys, "argv", argv), \
                    patch.object(probe, "_ready_root", side_effect=ValueError("setup boundary reached")):
                with self.assertRaisesRegex(ValueError, "setup boundary reached"):
                    probe.main()
            self.assertTrue(output.is_dir())


if __name__ == "__main__":
    unittest.main()
