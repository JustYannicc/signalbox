# pyright: reportImplicitRelativeImport=false, reportUninitializedInstanceVariable=false
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from prepare_probe import prepare


class ProbeFixtureTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.artifact = self.root / "artifact"
        self.artifact.mkdir()
        (self.artifact / "engine.wasm").write_bytes(b"\0asm\x01\0\0\0")
        (self.artifact / "loader.mjs").write_text("export function loadCodex() {}\n")

    def manifest(self, target):
        module = self.artifact / "engine.wasm"
        info = {
            "version": "0.162.1", "target": target, "abiVersion": 1,
            "moduleBytes": module.stat().st_size,
            "moduleSha256": hashlib.sha256(module.read_bytes()).hexdigest(),
            "files": {file.name: {"sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
                                  "bytes": file.stat().st_size}
                      for file in self.artifact.iterdir() if file.name != "manifest.json"},
        }
        (self.artifact / "manifest.json").write_text(json.dumps(info))

    def test_wasi_has_a_resolvable_static_module_map(self):
        self.manifest("wasm32-wasip1")
        output = self.root / "fixture"
        prepare(self.artifact, output)
        fixture = json.loads((output / "manifest.json").read_text())
        self.assertRegex(fixture["id"], r"^[A-Za-z0-9-]{1,100}$")
        self.assertTrue(fixture["id"].startswith("codex-0-162-1-"))
        self.assertEqual(set(fixture["modules"]), {"main.js", "loader.mjs", "engine-info.mjs", "engine.wasm"})
        for name, entry in fixture["modules"].items():
            self.assertEqual(name, entry["path"])
            self.assertTrue((output / entry["path"]).is_file())
        source = (output / "main.js").read_text()
        self.assertIn('import module from "./engine.wasm"', source)

    def test_emscripten_map_includes_the_static_factory(self):
        (self.artifact / "engine.mjs").write_text("export default function factory() {}")
        self.manifest("wasm32-unknown-emscripten")
        output = self.root / "fixture"
        prepare(self.artifact, output)
        fixture = json.loads((output / "manifest.json").read_text())
        self.assertEqual(set(fixture["modules"]),
                         {"main.js", "loader.mjs", "engine-info.mjs", "engine.wasm", "engine.mjs"})
        for name, entry in fixture["modules"].items():
            self.assertEqual(name, entry["path"])
            self.assertTrue((output / entry["path"]).is_file())
        self.assertEqual((output / "engine.mjs").read_bytes(), (self.artifact / "engine.mjs").read_bytes())
        self.assertIn('import module from "./engine.wasm"', (output / "main.js").read_text())

    def test_changed_factory_is_rejected_before_output_exists(self):
        (self.artifact / "engine.mjs").write_text("original factory")
        self.manifest("wasm32-unknown-emscripten")
        (self.artifact / "engine.mjs").write_text("changed factory")
        output = self.root / "rejected"
        with self.assertRaisesRegex(ValueError, "differs from its manifest"):
            prepare(self.artifact, output)
        self.assertFalse(output.exists())

    def test_unsupported_target_is_rejected_before_output_exists(self):
        self.manifest("unsupported-target")
        output = self.root / "rejected"
        with self.assertRaisesRegex(ValueError, "Only wasm32-wasip1 and wasm32-unknown-emscripten"):
            prepare(self.artifact, output)
        self.assertFalse(output.exists())

    def test_changed_module_or_loader_is_rejected_before_output_exists(self):
        self.manifest("wasm32-wasip1")
        for name in ["engine.wasm", "loader.mjs"]:
            with self.subTest(name=name):
                path = self.artifact / name
                original = path.read_bytes()
                path.write_bytes(original + b"changed")
                output = self.root / "rejected"
                with self.assertRaisesRegex(ValueError, "differs from its manifest"):
                    prepare(self.artifact, output)
                self.assertFalse(output.exists())
                path.write_bytes(original)


if __name__ == "__main__":
    unittest.main()
