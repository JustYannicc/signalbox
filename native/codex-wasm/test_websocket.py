"""Focused structural checks against the immutable official 0.162.1 source."""

import hashlib
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import websocket
from overlay import OverlayError

SOURCE = Path(os.environ.get("CODEX_OVERLAY_TEST_SOURCE", str(
    Path(__file__).parent / ".cache/sources/codex/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d")))
CLIENT = "codex-rs/websocket-client/src/lib.rs"
TARGET = "wasm32-wasip1"
REAL_ASSETS = websocket._ASSETS


def snapshot(root):
    return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()}


@unittest.skipUnless((SOURCE / CLIENT).is_file(), "requires frozen official Codex source")
class StructuralTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / "copy"
        self.path = self.root / CLIENT
        self.path.parent.mkdir(parents=True)
        self.original = (SOURCE / CLIENT).read_text()
        self.path.write_text(self.original)
        manifest = self.root / "codex-rs/Cargo.toml"
        shutil.copyfile(SOURCE / "codex-rs/Cargo.toml", manifest)
        # Structural tests do not invent a public reactor API or claim compilation.
        assets = Path(temporary.name) / "assets"
        assets.mkdir()
        shutil.copyfile(websocket._ASSETS / "rules.json", assets / "rules.json")
        for name in websocket._REQUIRED:
            (assets / name).write_text("// Structural fixture, never compiled.\n")
        override = patch.object(websocket, "_ASSETS", assets)
        override.start()
        self.addCleanup(override.stop)

    def apply(self, target=TARGET):
        return websocket.apply_websocket_overlay(self.root, target)

    def assert_rejected_without_writes(self, regex="#1072"):
        before = snapshot(self.root)
        with self.assertRaisesRegex(OverlayError, regex):
            self.apply()
        self.assertEqual(snapshot(self.root), before)

    def test_official_source_and_idempotence(self):
        digest = hashlib.sha256((SOURCE / CLIENT).read_bytes()).hexdigest()
        rules = websocket._rules()
        self.assertEqual(len(self.apply()), len(rules) + len(websocket._REQUIRED))
        result = snapshot(self.root)
        self.assertEqual(self.apply(), [])
        self.assertEqual(self.apply("wasm32-wasip1-threads"), [])
        self.assertEqual(snapshot(self.root), result)
        self.assertEqual(hashlib.sha256((SOURCE / CLIENT).read_bytes()).hexdigest(), digest)
        self.assertIn('type ConnectionInner = dialer::HostConnection', self.path.read_text())

    def test_real_assets_apply_without_an_api_stub_and_reapply_unchanged(self):
        with patch.object(websocket, "_ASSETS", REAL_ASSETS):
            self.apply()
            result = snapshot(self.root)
            self.assertEqual(self.apply(), [])
            self.assertEqual(snapshot(self.root), result)
            for asset in REAL_ASSETS.glob("*.rs"):
                self.assertEqual((self.root / websocket._MODULE / asset.name).read_bytes(), asset.read_bytes())

    def test_native_and_outer_policy_cookie_bodies_stay_identical(self):
        self.apply()
        result = self.path.read_text()
        for start, end in [
            ("pub(crate) type ConnectionInner = Either<", "/// Async network I/O"),
            ("pub struct WebSocketConnection", "pub(crate) type ConnectionInner"),
            ("        let url = url::Url", "fn is_loopback_destination"),
        ]:
            old = self.original[self.original.index(start):self.original.index(end)]
            self.assertIn(old.rstrip(), result)

    def test_comment_whitespace_drift_and_nested_comments(self):
        self.path.write_text(self.original.replace("mod dialer;", "mod /* outer /* inner */ ok */ dialer ;"))
        self.apply()
        self.assertIn("/* outer /* inner */ ok */", self.path.read_text())
        self.assertEqual(self.apply(), [])

    def test_comments_and_whitespace_between_generic_closers_are_preserved(self):
        source = self.original.replace("Stream<TcpStream>>", "Stream<TcpStream> /* closer */ >")
        source = source.replace("Box<dyn AsyncIo>>", "Box<dyn AsyncIo> >")
        self.path.write_text(source)
        self.apply()
        native = source[source.index("pub(crate) type ConnectionInner = Either<"):source.index("/// Async network I/O")].rstrip()
        self.assertIn(native, self.path.read_text())
        self.assertEqual(self.apply(), [])

    def test_ambiguous_module_and_alias(self):
        for extra in ["mod dialer;", self.original[self.original.index("pub(crate) type ConnectionInner = Either<"):self.original.index("/// Async network I/O")]]:
            with self.subTest(extra=extra):
                self.path.write_text(self.original + extra)
                self.assert_rejected_without_writes()

    def test_unfamiliar_alias_module_constructor_and_cfg(self):
        for old, new in [("mod dialer;", "mod other_dialer;"),
                         ("ConnectionInner = Either<", "ConnectionInner = Custom<"),
                         ("let tls_config = match tls_mode", "let tls_config = match modified"),
                         ("mod dialer;", '#[cfg(target_os = "wasi")] mod dialer;'),
                         ("mod dialer;", '#[path = "custom.rs"] mod dialer;'),
                         ("mod dialer;", "pub mod dialer;"),
                         ("mod dialer;", "mod nested { mod dialer; }")]:
            with self.subTest(old=old):
                self.path.write_text(self.original.replace(old, new))
                self.assert_rejected_without_writes()

    def test_strings_cannot_impersonate_module(self):
        self.path.write_text(self.original.replace("mod dialer;", 'const EXAMPLE: &str = "mod dialer;";'))
        self.assert_rejected_without_writes()

    def test_late_asset_failure_does_not_write_earlier_source(self):
        module = self.root / websocket._MODULE
        module.mkdir()
        (module / "transport.rs").write_text("fn unfamiliar() {}")
        self.assert_rejected_without_writes()

    def test_unknown_existing_module_file_fails(self):
        module = self.root / websocket._MODULE
        module.mkdir()
        (module / "surprise.rs").write_text("fn surprising() {}")
        self.assert_rejected_without_writes()

    def test_bad_rust_lexing_fails_without_writes(self):
        self.path.write_text(self.original + "/* unterminated")
        self.assert_rejected_without_writes()

    def test_checkouts_symlinks_hardlinks_and_native_target_refused(self):
        git = self.root / ".git"
        git.write_text("gitdir: elsewhere")
        self.assert_rejected_without_writes("without .git")
        git.unlink()
        backup = self.path.with_name("original.rs")
        self.path.rename(backup)
        for symlink in (True, False):
            self.path.symlink_to(backup) if symlink else os.link(backup, self.path)
            self.assert_rejected_without_writes("symlink|independent")
            self.path.unlink()
        backup.rename(self.path)
        before = snapshot(self.root)
        with self.assertRaisesRegex(OverlayError, "unsupported"):
            self.apply("aarch64-apple-darwin")
        self.assertEqual(snapshot(self.root), before)

    def test_future_version_with_same_structure_is_accepted(self):
        manifest = self.root / "codex-rs/Cargo.toml"
        manifest.write_text(manifest.read_text().replace('version = "0.162.1"', 'version = "0.163.0"'))
        self.assertTrue(self.apply())
        self.assertEqual(self.apply(), [])

    def test_future_version_with_unfamiliar_shape_fails_atomically(self):
        manifest = self.root / "codex-rs/Cargo.toml"
        manifest.write_text(manifest.read_text().replace('version = "0.162.1"', 'version = "0.163.0"'))
        self.path.write_text(self.original.replace("mod dialer;", "mod new_dialer;"))
        self.assert_rejected_without_writes()


if __name__ == "__main__":
    unittest.main()
