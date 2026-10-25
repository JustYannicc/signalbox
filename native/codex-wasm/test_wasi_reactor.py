import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import wasi_reactor as reactor


class WasiReactorTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="wasi reactor ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.cache = self.root / "cache"
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "sentinel").write_text("original source")
        self.tokio = self.root / "base/tokio"
        (self.tokio / "src").mkdir(parents=True)
        (self.tokio / "Cargo.toml").write_text(
            '[package]\nname="tokio"\nversion="1.52.3"\n')
        (self.tokio / "src/lib.rs").write_text("agentOS plus existing wrapper patches\n")
        self.base = {"tokio": self.tokio, "socket2": self.root / "base/socket2",
                     "libc": self.root / "base/libc"}
        self.assets = self.root / "assets"
        self.assets.mkdir()
        for name, original in [("tokio", "agentOS plus existing wrapper patches"),
                               ("mio", "pristine mio")]:
            (self.assets / f"{name}.patch").write_text(
                f'--- a/{name}/src/lib.rs\n+++ b/{name}/src/lib.rs\n'
                f'@@ -1 +1 @@\n-{original}\n+{original} plus reactor\n')
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            for name, data in {
                "mio-1.2.0/Cargo.toml": b'[package]\nname="mio"\nversion="1.2.0"\n',
                "mio-1.2.0/src/lib.rs": b'pristine mio\n',
                "mio-1.2.0/LICENSE": b'upstream license\n',
            }.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        self.archive = buffer.getvalue()
        self.enterContext(patch.object(reactor, "ASSETS", self.assets))
        self.enterContext(patch.object(reactor, "MIO", ("1.2.0", hashlib.sha256(self.archive).hexdigest())))
        self.network = self.enterContext(patch("urllib.request.urlopen", side_effect=lambda *a, **kw:
                                               io.BytesIO(self.archive)))

    def prepare(self):
        return reactor.prepare_wasi_reactor(self.cache, {"codex": self.source}, self.base)

    def test_copies_patched_tokio_and_returns_complete_map_without_mutation(self):
        before = dict(self.base)
        paths = self.prepare()
        self.assertEqual(self.base, before)
        self.assertIsNot(paths, self.base)
        self.assertEqual(set(paths), {"tokio", "mio", "libc", "socket2"})
        for name in ("libc", "socket2"):
            self.assertIs(paths[name], self.base[name])
        self.assertEqual((paths["tokio"] / "src/lib.rs").read_text(),
                         "agentOS plus existing wrapper patches plus reactor\n")
        self.assertEqual((self.tokio / "src/lib.rs").read_text(),
                         "agentOS plus existing wrapper patches\n")
        self.assertEqual((paths["mio"] / "src/lib.rs").read_text(), "pristine mio plus reactor\n")
        self.assertEqual((paths["mio"] / "LICENSE").read_text(), "upstream license\n")
        for name in ("tokio", "mio"):
            self.assertTrue(paths[name].is_absolute())
            self.assertTrue(paths[name].is_relative_to(self.cache.resolve()))
        self.assertEqual(list(self.source.iterdir()), [self.source / "sentinel"])

    def test_reuse_checks_inventory_without_network_or_patches(self):
        paths = self.prepare()
        self.network.side_effect = AssertionError("network during reuse")
        with patch.object(reactor, "patch_series", side_effect=AssertionError("patch during reuse")):
            self.assertEqual(self.prepare(), paths)
        self.assertEqual(self.network.call_count, 1)

    def test_input_content_and_wrapper_patches_identify_new_stages(self):
        first = self.prepare()
        (self.tokio / "new-base-file").write_text("upstream compatibility change")
        second = self.prepare()
        self.assertNotEqual(first["tokio"], second["tokio"])
        patch_file = self.assets / "mio.patch"
        patch_file.write_text(patch_file.read_text().replace("plus reactor", "plus updated reactor"))
        third = self.prepare()
        self.assertNotEqual(second["mio"], third["mio"])
        self.assertEqual((first["mio"] / "src/lib.rs").read_text(), "pristine mio plus reactor\n")

    def test_cache_tampering_and_removed_files_fail_closed(self):
        paths = self.prepare()
        source = paths["mio"] / "src/lib.rs"
        original = source.read_text()
        source.write_text("modified")
        with self.assertRaisesRegex(ValueError, "cache changed"):
            self.prepare()
        source.write_text(original)
        source.unlink()
        with self.assertRaisesRegex(ValueError, "cache changed"):
            self.prepare()

    def test_marker_identity_and_package_versions_are_checked(self):
        paths = self.prepare()
        marker = paths["mio"].parent / ".ready"
        original = marker.read_text()
        changed = json.loads(original)
        changed["identity"] = "wrong"
        marker.write_text(json.dumps(changed))
        with self.assertRaisesRegex(ValueError, "cache changed"):
            self.prepare()
        marker.write_text(original)
        manifest = paths["tokio"] / "Cargo.toml"
        manifest.write_text(manifest.read_text().replace("1.52.3", "1.52.4"))
        with self.assertRaisesRegex(ValueError, "expected tokio 1.52.3"):
            self.prepare()

    def test_wrong_input_version_and_missing_assets_fail_before_download(self):
        manifest = self.tokio / "Cargo.toml"
        original = manifest.read_text()
        manifest.write_text(original.replace("1.52.3", "1.0.0"))
        with self.assertRaisesRegex(ValueError, "expected tokio 1.52.3"):
            self.prepare()
        manifest.write_text(original)
        (self.assets / "mio.patch").unlink()
        with self.assertRaisesRegex(ValueError, "missing WASI reactor patch"):
            self.prepare()
        self.network.assert_not_called()

    def test_checksum_failure_never_publishes_partial_stage(self):
        self.archive += b"corrupt"
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            self.prepare()
        self.assertEqual(list(self.cache.glob("wasi-reactor-*")), [])
        self.assertEqual(list(self.cache.glob(".wasi-reactor-*")), [])

    def test_patch_failure_is_atomic_and_retryable(self):
        with patch.object(reactor, "patch_series", side_effect=RuntimeError("patch failed")):
            with self.assertRaisesRegex(RuntimeError, "patch failed"):
                self.prepare()
        self.assertEqual(list(self.cache.glob("wasi-reactor-*")), [])
        self.assertEqual(list(self.cache.glob(".wasi-reactor-*")), [])
        self.assertIn("mio", self.prepare())

    def test_copy_race_is_detected_before_download(self):
        copytree = reactor.shutil.copytree

        def changed_input(*args, **kwargs):
            result = copytree(*args, **kwargs)
            (self.tokio / "raced").write_text("concurrent input change")
            return result

        with patch.object(reactor.shutil, "copytree", side_effect=changed_input):
            with self.assertRaisesRegex(ValueError, "input changed"):
                self.prepare()
        self.network.assert_not_called()
        self.assertEqual(list(self.cache.glob("wasi-reactor-*")), [])

    def test_output_inside_source_or_any_base_is_rejected(self):
        for boundary in (self.source, self.tokio, self.base["libc"]):
            with self.subTest(boundary=boundary):
                with self.assertRaisesRegex(ValueError, "inside a source checkout"):
                    reactor.prepare_wasi_reactor(boundary / "cache", {"codex": self.source}, self.base)
        self.network.assert_not_called()

    def test_input_and_output_symlinks_are_rejected(self):
        (self.tokio / "link").symlink_to(self.source / "sentinel")
        with self.assertRaisesRegex(ValueError, "must not contain symlinks"):
            self.prepare()
        (self.tokio / "link").unlink()
        paths = self.prepare()
        root = paths["mio"].parent
        moved = root.with_name("moved")
        root.rename(moved)
        root.symlink_to(moved, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "redirect to inputs"):
            self.prepare()
        root.unlink()
        moved.rename(root)
        (paths["tokio"] / "link").symlink_to(self.source / "sentinel")
        with self.assertRaisesRegex(ValueError, "must not contain symlinks"):
            self.prepare()


if __name__ == "__main__":
    unittest.main()
