"""Emscripten keeps Unix behavior with native TLS and telemetry client gates."""

import os
from pathlib import Path
import shutil
import tempfile
import tomllib
import unittest

import overlay


class EmscriptenOverlayTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        grouped = {}
        for rule in overlay._target_rules("wasm32-unknown-emscripten"):
            grouped.setdefault(rule["path"], []).append(rule)
        for name, rules in grouped.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("\n".join(overlay._text(rule, "before") for rule in rules))

    def apply(self):
        return overlay.apply_overlay(self.root, "wasm32-unknown-emscripten")

    def snapshot(self):
        return {str(path.relative_to(self.root)): path.read_bytes()
                for path in self.root.rglob("*") if path.is_file()}

    def test_native_tls_and_telemetry_are_gated_and_repeat_is_a_noop(self):
        untouched = self.root / "codex-rs/git-utils/src/platform.rs"
        untouched.parent.mkdir(parents=True)
        untouched.write_text("#[cfg(unix)] fn unchanged() {}\n")
        changes = self.apply()
        self.assertEqual(len(changes), 9)
        self.assertEqual({change["rule"] for change in changes},
                         {"native-tls-remove", "native-tls-target", "native-tls-error",
                          "otel-metrics-async-tls", "otel-logs-async-tls", "otel-traces-async-tls",
                          "shell-snapshot-spawn-unsupported", "shell-snapshot-wait-unsupported",
                          "core-recursion-limit"})
        manifest = tomllib.loads((self.root / "codex-rs/http-client/Cargo.toml").read_text())
        self.assertNotIn("native-tls", manifest)
        self.assertIn("native-tls", manifest["target"]['cfg(not(target_os = "emscripten"))']["dependencies"])
        self.assertEqual(untouched.read_text(), "#[cfg(unix)] fn unchanged() {}\n")
        result = self.snapshot()
        self.assertEqual(self.apply(), [])
        self.assertEqual(self.snapshot(), result)

    def test_unknown_telemetry_shape_cannot_partially_change_native_tls(self):
        path = self.root / "codex-rs/otel/src/provider.rs"
        path.write_text(path.read_text().replace("OTEL_EXPORTER_OTLP_TRACES_TIMEOUT", "CHANGED"))
        before = self.snapshot()
        with self.assertRaisesRegex(overlay.OverlayError, "#1072"):
            self.apply()
        self.assertEqual(self.snapshot(), before)

    def test_whitespace_and_comments_preserve_unrelated_source(self):
        path = self.root / "codex-rs/http-client/src/route_aware_client_pool.rs"
        path.write_text(path.read_text().replace("while let", "// keep this comment\nwhile   let"))
        self.apply()
        self.assertIn("// keep this comment", path.read_text())
        self.assertEqual(self.apply(), [])

    def test_unknown_source_shape_cannot_partially_change_the_manifest(self):
        path = self.root / "codex-rs/http-client/src/route_aware_client_pool.rs"
        path.write_text(path.read_text().replace("tunnel error: proxy authorization required", "changed"))
        before = self.snapshot()
        with self.assertRaisesRegex(overlay.OverlayError, "#1072"):
            self.apply()
        self.assertEqual(self.snapshot(), before)

    def test_unrecognized_platform_arm_is_rejected_before_any_write(self):
        path = self.root / "codex-rs/http-client/src/route_aware_client_pool.rs"
        path.write_text(path.read_text() + '\n#[cfg(target_os = "emscripten")] fn unknown() {}\n')
        before = self.snapshot()
        with self.assertRaisesRegex(overlay.OverlayError, "unrecognized emscripten"):
            self.apply()
        self.assertEqual(self.snapshot(), before)

    def test_ambiguous_native_dependency_is_rejected(self):
        path = self.root / "codex-rs/http-client/Cargo.toml"
        path.write_text(path.read_text() * 2)
        before = self.snapshot()
        with self.assertRaisesRegex(overlay.OverlayError, "#1072"):
            self.apply()
        self.assertEqual(self.snapshot(), before)

    @unittest.skipUnless(os.environ.get("CODEX_OVERLAY_TEST_SOURCE"), "official source not provided")
    def test_actual_official_http_client_copy(self):
        source = Path(os.environ["CODEX_OVERLAY_TEST_SOURCE"])
        for relative in self.snapshot():
            shutil.copy2(source / relative, self.root / relative)
        changes = self.apply()
        self.assertEqual(len(changes), 9)
        self.assertEqual(self.apply(), [])


if __name__ == "__main__":
    unittest.main()
