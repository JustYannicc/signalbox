import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import tomllib
import unittest
from unittest.mock import patch

import emscripten_crypto as crypto
from workspace import prepare_workspace


def archive_bytes(files):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w:gz") as archive:
        for name, contents in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(contents)
            archive.addfile(member, io.BytesIO(contents))
    return data.getvalue()


class EmscriptenCryptoTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="emscripten crypto ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.cache = self.root / "cache"
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "pristine").write_text("unchanged source")
        self.sources = {"codex": self.source}
        self.assets = self.root / "patches"
        self.assets.mkdir()
        self.archive = archive_bytes({
            "ring-0.17.14/Cargo.toml": b'[package]\nname="ring"\nversion="0.17.14"\n',
            "ring-0.17.14/src/lib.rs": b'pub fn original() {}\n',
            "ring-0.17.14/LICENSE": b'upstream license\n',
        })
        (self.assets / "ring.patch").write_text(
            '--- a/ring/src/lib.rs\n+++ b/ring/src/lib.rs\n'
            '@@ -1 +1 @@\n-pub fn original() {}\n+pub fn adapted() {}\n')
        self.enterContext(patch.object(crypto, "CRATES", {
            "ring": ("0.17.14", hashlib.sha256(self.archive).hexdigest()),
        }))
        self.enterContext(patch.object(crypto, "ASSETS", self.assets))
        self.network = self.enterContext(patch("urllib.request.urlopen", side_effect=lambda *args, **kw:
                                               io.BytesIO(self.archive)))

    def prepare(self):
        return crypto.prepare_emscripten_crypto(self.cache, self.sources)

    def test_map_integrates_with_workspace_and_preserves_sources(self):
        paths = self.prepare()
        self.assertEqual(set(paths), {"ring"})
        ring = paths["ring"]
        self.assertTrue(ring.is_absolute())
        self.assertTrue(ring.is_relative_to(self.cache.resolve()))
        self.assertEqual((ring / "src/lib.rs").read_text(), "pub fn adapted() {}\n")
        self.assertEqual((ring / "LICENSE").read_text(), "upstream license\n")
        copied = self.root / "copied/codex-rs"
        copied.mkdir(parents=True)
        (copied / "Cargo.toml").write_text('[workspace]\nmembers=[]\n[workspace.package]\nversion="0.0.0"\n[profile.release]\n')
        engine = self.root / "engine"
        engine.mkdir()
        (engine / "Cargo.toml").write_text('[package]\nname="fixture"\nversion="1.0.0"\n')
        workspace = prepare_workspace(copied.parent, engine, paths, "0.162.1")
        manifest = tomllib.loads((workspace / "Cargo.toml").read_text())
        self.assertEqual(manifest["patch"]["crates-io"], {"ring": {"path": str(ring)}})
        self.assertEqual(list(self.source.iterdir()), [self.source / "pristine"])
        self.assertEqual((self.source / "pristine").read_text(), "unchanged source")

    def test_reuse_needs_no_network_or_patch_application(self):
        paths = self.prepare()
        self.network.side_effect = AssertionError("network during reuse")
        with patch.object(crypto, "patch_series", side_effect=AssertionError("patch during reuse")):
            self.assertEqual(paths, self.prepare())
        self.assertEqual(self.network.call_count, 1)

    def test_patch_changes_select_a_new_stage(self):
        before = self.prepare()
        patch_file = self.assets / "ring.patch"
        patch_file.write_text(patch_file.read_text().replace("adapted", "changed"))
        after = self.prepare()
        self.assertNotEqual(before, after)
        self.assertIn("changed", (after["ring"] / "src/lib.rs").read_text())
        self.assertIn("adapted", (before["ring"] / "src/lib.rs").read_text())

    def test_changed_or_added_cached_files_are_rejected(self):
        paths = self.prepare()
        source = paths["ring"] / "src/lib.rs"
        original = source.read_bytes()
        source.write_text("changed after preparation")
        with self.assertRaisesRegex(ValueError, "crypto cache changed"):
            self.prepare()
        source.write_bytes(original)
        extra = paths["ring"].parent / "extra"
        extra.write_text("unexpected")
        with self.assertRaisesRegex(ValueError, "crypto cache changed"):
            self.prepare()

    def test_wrong_cached_package_is_rejected(self):
        paths = self.prepare()
        manifest = paths["ring"] / "Cargo.toml"
        manifest.write_text(manifest.read_text().replace('version="0.17.14"', 'version="0.0.0"'))
        with self.assertRaisesRegex(ValueError, "expected ring 0.17.14"):
            self.prepare()

    def test_bad_download_checksum_cannot_publish_a_stage(self):
        self.archive += b"corrupt"
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            self.prepare()
        self.assertFalse(list(self.cache.glob("emscripten-crypto-*")))
        self.assertFalse(list(self.cache.glob(".emscripten-crypto-*")))
        self.assertFalse(list((self.cache / "downloads").glob("*.partial")))

    def test_bad_cached_archive_checksum_cannot_publish_a_stage(self):
        downloads = self.cache / "downloads"
        downloads.mkdir(parents=True)
        (downloads / "ring-0.17.14.crate").write_bytes(self.archive + b"corrupt")
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch for cached"):
            self.prepare()
        self.network.assert_not_called()
        self.assertFalse(list(self.cache.glob("emscripten-crypto-*")))

    def test_failed_patch_cannot_publish_a_stage_and_can_retry(self):
        with patch.object(crypto, "patch_series", side_effect=RuntimeError("patch failed")):
            with self.assertRaisesRegex(RuntimeError, "patch failed"):
                self.prepare()
        self.assertFalse(list(self.cache.glob("emscripten-crypto-*")))
        self.assertFalse(list(self.cache.glob(".emscripten-crypto-*")))
        self.assertEqual(set(self.prepare()), {"ring"})

    def test_missing_patch_cannot_return_pristine_ring(self):
        (self.assets / "ring.patch").unlink()
        with self.assertRaisesRegex(ValueError, "missing Emscripten crypto patch"):
            self.prepare()
        self.network.assert_not_called()

    def test_cache_inside_source_and_symlink_alias_are_rejected(self):
        alias = self.root / "alias"
        alias.symlink_to(self.source, target_is_directory=True)
        for cache in (self.source / "cache", alias / "cache"):
            with self.assertRaisesRegex(ValueError, "inside a source checkout"):
                crypto.prepare_emscripten_crypto(cache, self.sources)
        self.network.assert_not_called()

    def test_source_nested_in_selected_stage_is_rejected(self):
        stage = self.cache / f"emscripten-crypto-{crypto._identity()[:16]}"
        with self.assertRaisesRegex(ValueError, "contain or redirect to sources"):
            crypto.prepare_emscripten_crypto(self.cache, {"source": stage / "source"})
        self.network.assert_not_called()

    def test_symlink_stage_is_rejected(self):
        paths = self.prepare()
        root = paths["ring"].parent
        moved = root.with_name("moved")
        root.rename(moved)
        root.symlink_to(moved, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "redirect to sources"):
            self.prepare()

    def test_symlink_content_and_marker_are_rejected(self):
        paths = self.prepare()
        link = paths["ring"] / "src/link"
        link.symlink_to(self.source / "pristine")
        with self.assertRaisesRegex(ValueError, "must not contain symlinks"):
            self.prepare()
        link.unlink()
        marker = paths["ring"].parent / ".ready"
        marker.unlink()
        marker.symlink_to(self.source / "pristine")
        with self.assertRaisesRegex(ValueError, "must not contain symlinks"):
            self.prepare()

    def test_marker_identity_mismatch_and_missing_marker_are_rejected(self):
        paths = self.prepare()
        marker = paths["ring"].parent / ".ready"
        ready = json.loads(marker.read_text())
        ready["identity"] = "wrong"
        marker.write_text(json.dumps(ready))
        with self.assertRaisesRegex(ValueError, "crypto cache changed"):
            self.prepare()
        marker.unlink()
        with self.assertRaises(FileNotFoundError):
            self.prepare()


if __name__ == "__main__":
    unittest.main()
