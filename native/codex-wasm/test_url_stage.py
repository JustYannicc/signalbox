import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import tomllib
import unittest
from unittest.mock import patch

from dependencies import url_stage as url
from workspace import prepare_workspace


def archive_bytes(files):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w:gz") as archive:
        for name, contents in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(contents)
            archive.addfile(member, io.BytesIO(contents))
    return data.getvalue()


def file_bytes(root):
    return {str(path.relative_to(root)): path.read_bytes()
            for path in root.rglob("*") if path.is_file()}


class UrlStageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="url stage ")
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
            "url-2.5.8/Cargo.toml": b'[package]\nname="url"\nversion="2.5.8"\n',
            "url-2.5.8/src/lib.rs": b'pub fn original() {}\n',
            "url-2.5.8/LICENSE": b'upstream license\n',
        })
        (self.assets / "url.patch").write_text(
            '--- a/url/src/lib.rs\n+++ b/url/src/lib.rs\n'
            '@@ -1 +1 @@\n-pub fn original() {}\n+pub fn adapted() {}\n')
        self.enterContext(patch.object(url, "CRATES", {
            "url": ("2.5.8", hashlib.sha256(self.archive).hexdigest()),
        }))
        self.enterContext(patch.object(url, "ASSETS", self.assets))
        self.network = self.enterContext(patch("urllib.request.urlopen", side_effect=lambda *args, **kw:
                                               io.BytesIO(self.archive)))

    def prepare(self):
        return url.prepare_url_dependency(self.cache, self.sources)

    def test_absolute_map_integrates_with_workspace_and_preserves_inputs(self):
        before = file_bytes(self.source)
        registry = self.root / "cargo-home/registry/src/url-2.5.8"
        registry.mkdir(parents=True)
        (registry / "lib.rs").write_text("global registry stays unchanged")
        with patch.dict("os.environ", {"CARGO_HOME": str(registry.parent.parent.parent)}):
            paths = self.prepare()
        self.assertEqual(set(paths), {"url"})
        crate = paths["url"]
        self.assertTrue(crate.is_absolute())
        self.assertTrue(crate.is_relative_to(self.cache.resolve()))
        self.assertEqual((crate / "src/lib.rs").read_text(), "pub fn adapted() {}\n")
        self.assertEqual((crate / "LICENSE").read_text(), "upstream license\n")
        self.assertEqual(set(file_bytes(crate)), {"Cargo.toml", "LICENSE", "src/lib.rs"})
        copied = self.root / "copied/codex-rs"
        copied.mkdir(parents=True)
        (copied / "Cargo.toml").write_text(
            '[workspace]\nmembers=[]\n[workspace.package]\nversion="0.0.0"\n[profile.release]\n')
        engine = self.root / "engine"
        engine.mkdir()
        (engine / "Cargo.toml").write_text('[package]\nname="fixture"\nversion="1.0.0"\n')
        workspace = prepare_workspace(copied.parent, engine, paths, "0.162.1")
        manifest = tomllib.loads((workspace / "Cargo.toml").read_text())
        self.assertEqual(manifest["patch"]["crates-io"], {"url": {"path": str(crate)}})
        self.assertEqual(file_bytes(self.source), before)
        self.assertEqual(file_bytes(registry), {"lib.rs": b"global registry stays unchanged"})
        self.assertEqual((self.cache / "downloads/url-2.5.8.crate").read_bytes(), self.archive)

    def test_reuse_needs_no_network_or_patch_and_does_not_rewrite_stage(self):
        paths = self.prepare()
        before = file_bytes(paths["url"].parent)
        self.network.side_effect = AssertionError("network during reuse")
        with patch.object(url, "patch_series", side_effect=AssertionError("patch during reuse")):
            self.assertEqual(paths, self.prepare())
        self.assertEqual(file_bytes(paths["url"].parent), before)
        self.assertEqual(self.network.call_count, 1)

    def test_patch_and_archive_checksums_select_new_stages_preserving_old(self):
        first = self.prepare()
        before = file_bytes(first["url"].parent)
        patch_file = self.assets / "url.patch"
        patch_file.write_text(patch_file.read_text().replace("adapted", "changed"))
        second = self.prepare()
        self.assertNotEqual(first, second)
        self.assertIn("changed", (second["url"] / "src/lib.rs").read_text())
        self.assertEqual(file_bytes(first["url"].parent), before)
        with patch.object(url, "CRATES", {"url": ("2.5.8", "0" * 64)}):
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch for cached"):
                self.prepare()
        self.assertEqual(file_bytes(first["url"].parent), before)
        self.assertEqual(len(list(self.cache.glob("url-*"))), 2)

    def test_added_changed_and_removed_files_are_rejected_without_repair(self):
        paths = self.prepare()
        library = paths["url"] / "src/lib.rs"
        original = library.read_bytes()
        for mutation in (lambda: library.write_text("tampered"), library.unlink):
            mutation()
            with self.assertRaisesRegex(ValueError, "URL cache changed"):
                self.prepare()
            library.write_bytes(original)
        extra = paths["url"].parent / "extra"
        extra.write_text("unexpected")
        with self.assertRaisesRegex(ValueError, "URL cache changed"):
            self.prepare()
        self.assertEqual(extra.read_text(), "unexpected")

    def test_wrong_package_and_marker_tampering_are_rejected(self):
        paths = self.prepare()
        manifest = paths["url"] / "Cargo.toml"
        original = manifest.read_bytes()
        manifest.write_bytes(original.replace(b'2.5.8', b'0.0.0'))
        with self.assertRaisesRegex(ValueError, "expected url 2.5.8"):
            self.prepare()
        manifest.write_bytes(original)
        marker = paths["url"].parent / ".ready"
        ready = json.loads(marker.read_text())
        ready["identity"] = "wrong"
        marker.write_text(json.dumps(ready))
        with self.assertRaisesRegex(ValueError, "URL cache changed"):
            self.prepare()
        marker.unlink()
        with self.assertRaises(FileNotFoundError):
            self.prepare()

    def test_bad_download_and_cached_archive_cannot_publish_a_stage(self):
        original = self.archive
        self.archive += b"corrupt"
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            self.prepare()
        downloads = self.cache / "downloads"
        self.assertFalse(list(downloads.iterdir()))
        self.assertFalse(list(self.cache.glob("url-*")))
        self.assertFalse(list(self.cache.glob(".url-*")))
        (downloads / "url-2.5.8.crate").write_bytes(original + b"corrupt")
        self.network.reset_mock()
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch for cached"):
            self.prepare()
        self.network.assert_not_called()
        self.assertFalse(list(self.cache.glob("url-*")))

    def test_failed_patch_cleans_temporary_stage_and_can_retry(self):
        with patch.object(url, "patch_series", side_effect=RuntimeError("patch failed")):
            with self.assertRaisesRegex(RuntimeError, "patch failed"):
                self.prepare()
        self.assertFalse(list(self.cache.glob("url-*")))
        self.assertFalse(list(self.cache.glob(".url-*")))
        self.assertEqual(set(self.prepare()), {"url"})

    def test_missing_patch_cannot_return_pristine_url(self):
        (self.assets / "url.patch").unlink()
        with self.assertRaisesRegex(ValueError, "missing or symlinked URL patch"):
            self.prepare()
        self.network.assert_not_called()

    def test_unexpected_patch_backup_cannot_publish_a_stage(self):
        apply = url.patch_series

        def bad_backup(stage, patches):
            apply(stage, patches)
            (stage / "url/src/lib.rs.orig").write_text("unexpected backup")

        with patch.object(url, "patch_series", side_effect=bad_backup):
            with self.assertRaisesRegex(ValueError, "unexpected URL patch backup"):
                self.prepare()
        self.assertFalse(list(self.cache.glob("url-*")))
        self.assertFalse(list(self.cache.glob(".url-*")))

    def test_cache_inside_source_including_alias_is_rejected(self):
        alias = self.root / "alias"
        alias.symlink_to(self.source, target_is_directory=True)
        before = file_bytes(self.source)
        for cache in (self.source, self.source / "cache", alias / "cache"):
            with self.assertRaisesRegex(ValueError, "overlaps a source checkout"):
                url.prepare_url_dependency(cache, self.sources)
        self.assertEqual(file_bytes(self.source), before)
        self.network.assert_not_called()

    def test_source_in_stage_downloads_or_lock_is_rejected_before_writes(self):
        for path in (self.cache / f"url-{url._identity()[:16]}",
                     self.cache / "downloads", self.cache / ".prepare.lock"):
            with self.assertRaisesRegex(ValueError, "overlaps a source checkout"):
                url.prepare_url_dependency(self.cache, {"source": path / "source"})
        self.assertFalse(self.cache.exists())
        self.network.assert_not_called()

    def test_sources_can_be_siblings_of_stages_in_the_cache(self):
        source = self.cache / "sources/codex"
        source.mkdir(parents=True)
        (source / "pristine").write_text("source")
        self.assertEqual(set(url.prepare_url_dependency(self.cache, {"codex": source})), {"url"})
        self.assertEqual(file_bytes(source), {"pristine": b"source"})

    def test_symlink_stage_content_and_marker_are_rejected(self):
        paths = self.prepare()
        stage = paths["url"].parent
        moved = stage.with_name("moved")
        stage.rename(moved)
        stage.symlink_to(moved, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "must not contain symlinks"):
            self.prepare()
        stage.unlink()
        moved.rename(stage)
        for target in (stage / "url/src/link", stage / ".ready"):
            target.unlink(missing_ok=True)
            target.symlink_to(self.source / "pristine")
            with self.assertRaisesRegex(ValueError, "must not contain symlinks"):
                self.prepare()
            target.unlink()

    def test_symlink_downloads_archive_partial_and_lock_are_rejected(self):
        self.cache.mkdir()
        for target in (self.cache / "downloads", self.cache / ".prepare.lock"):
            target.symlink_to(self.source)
            with self.assertRaisesRegex(ValueError, "must not contain symlinks"):
                self.prepare()
            target.unlink()
        downloads = self.cache / "downloads"
        downloads.mkdir()
        for filename in ("url-2.5.8.crate", "url-2.5.8.crate.partial"):
            target = downloads / filename
            target.symlink_to(self.source / "pristine")
            with self.assertRaisesRegex(ValueError, "must not contain symlinks"):
                self.prepare()
            target.unlink()
        self.assertEqual(file_bytes(self.source), {"pristine": b"unchanged source"})
        self.network.assert_not_called()


class UrlPatchProvenanceTests(unittest.TestCase):
    def test_reviewed_backport_has_only_stage_path_prefix_changes(self):
        adapted = (Path(__file__).parent / "dependencies/patches/url.patch").read_bytes()
        original = adapted.replace(b"a/url/src/lib.rs", b"a/src/lib.rs").replace(
            b"b/url/src/lib.rs", b"b/src/lib.rs")
        self.assertEqual(hashlib.sha256(original).hexdigest(),
                         "06a9cfedca9450ee35cbf66a402f2034e1c1793f4da9a996907be554274d00b6")


if __name__ == "__main__":
    unittest.main()
