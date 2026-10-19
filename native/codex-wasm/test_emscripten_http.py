import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import emscripten_http as http


class EmscriptenHttpTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="emscripten http ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "pristine").write_text("unchanged")
        self.cache = self.root / "cache"
        self.assets = self.root / "assets"
        self.assets.mkdir()
        (self.assets / "reuse.patch").write_text(
            '--- a/toolchain/stubs/reqwest-shim/src/lib.rs\n'
            '+++ b/toolchain/stubs/reqwest-shim/src/lib.rs\n'
            '@@ -1 +1 @@\n-pub fn original() {}\n+pub fn adapted() {}\n')
        (self.assets / "imports.js").write_bytes((http.ASSETS / "imports.js").read_bytes())
        self.enterContext(patch.object(http, "ASSETS", self.assets))
        self.archive = self.enterContext(patch.object(http, "git_archive", side_effect=self.populate))

    def populate(self, repository, revision, paths, stage):
        self.assertEqual(repository, self.source)
        self.assertEqual(revision, http.AGENTOS)
        self.assertEqual(set(paths), {relative for relative, _ in http.DIRECTORIES.values()})
        for name, (relative, version) in http.DIRECTORIES.items():
            path = stage / relative
            (path / "src").mkdir(parents=True)
            (path / "src/lib.rs").write_text("pub fn original() {}\n")
            (path / "LICENSE").write_text("original license\n")
            manifest = f'[package]\nname="{name}"\nversion="{version}"\n'
            if name == "reqwest":
                manifest += '[dependencies.wasi-http]\npath="../../crates/libs/wasi-http"\n'
            if name == "agentos-wasi-http":
                manifest += '[dependencies.wasi-ext]\npath="../../wasi-ext"\n'
            (path / "Cargo.toml").write_text(manifest)

    def prepare(self):
        return http.prepare_emscripten_http(self.cache, {"agentos": self.source})

    def test_pinned_copy_preserves_paths_licenses_and_original(self):
        result = self.prepare()
        self.assertEqual(set(result), {"reqwest"})
        reqwest = result["reqwest"]
        self.assertTrue(reqwest.is_absolute())
        self.assertEqual((reqwest / "src/lib.rs").read_text(), "pub fn adapted() {}\n")
        self.assertEqual((reqwest / "LICENSE").read_text(), "original license\n")
        self.assertTrue((reqwest / "../../crates/libs/wasi-http/Cargo.toml").is_file())
        self.assertTrue((reqwest / "../../crates/wasi-ext/Cargo.toml").is_file())
        self.assertEqual(list(self.source.iterdir()), [self.source / "pristine"])
        self.assertEqual((self.source / "pristine").read_text(), "unchanged")

    def test_reuse_checks_inventory_without_archiving_or_patching(self):
        before = self.prepare()
        self.archive.side_effect = AssertionError("archive during reuse")
        with patch.object(http, "patch_series", side_effect=AssertionError("patch during reuse")):
            self.assertEqual(before, self.prepare())

    def test_cache_changed_added_file_or_relative_dependency_is_rejected(self):
        result = self.prepare()
        extra = result["reqwest"] / "unexpected"
        extra.write_text("changed")
        with self.assertRaisesRegex(ValueError, "cache changed"):
            self.prepare()
        extra.unlink()
        manifest = result["reqwest"] / "Cargo.toml"
        manifest.write_text(manifest.read_text().replace("../../crates/libs/wasi-http", "/tmp/elsewhere"))
        with self.assertRaisesRegex(ValueError, "relative dependencies changed"):
            self.prepare()

    def test_assets_select_new_stage_and_failed_stage_is_not_published(self):
        before = self.prepare()
        imports = self.assets / "imports.js"
        imports.write_text(imports.read_text() + "\n// changed host declarations\n")
        with patch.object(http, "patch_series", side_effect=RuntimeError("failed patch")):
            with self.assertRaisesRegex(RuntimeError, "failed patch"):
                self.prepare()
        self.assertEqual(len(list(self.cache.glob("emscripten-http-*"))), 1)
        self.assertFalse(list(self.cache.glob(".emscripten-http-*")))
        self.assertNotEqual(before, self.prepare())

    def test_source_boundary_symlink_and_missing_asset_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "inside a source checkout"):
            http.prepare_emscripten_http(self.source / "cache", {"agentos": self.source})
        result = self.prepare()
        (result["reqwest"] / "redirect").symlink_to(self.source / "pristine")
        with self.assertRaisesRegex(ValueError, "must not contain symlinks"):
            self.prepare()
        (self.assets / "reuse.patch").unlink()
        with self.assertRaisesRegex(ValueError, "missing Emscripten HTTP asset"):
            self.prepare()

    def test_symlink_stage_is_not_followed(self):
        result = self.prepare()
        stage = result["reqwest"].parents[2]
        renamed = stage.with_name("moved")
        stage.rename(renamed)
        stage.symlink_to(renamed, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "redirect to sources"):
            self.prepare()

    def test_js_declarations_fail_for_every_http_import(self):
        script = """
import * as Assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as VM from 'node:vm';
let declarations;
VM.runInNewContext(FS.readFileSync(process.argv[1], 'utf8'), {
  addToLibrary(value) { declarations = value; },
});
Assert.deepEqual(Object.keys(declarations).sort(), JSON.parse(process.argv[2]).sort());
for (const name of Object.keys(declarations)) {
  Assert.throws(() => declarations[name](), new RegExp('Unsupported HTTP host_net.' + name));
}
"""
        node = shutil.which("node")
        self.assertIsNotNone(node)
        assert node is not None
        subprocess.run([node, "--input-type=module", "-e", script,
                        str(self.assets / "imports.js"), json.dumps(http.HOST_IMPORTS)], check=True)


if __name__ == "__main__":
    unittest.main()
