import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import tomllib
import unittest
from unittest.mock import patch

import emscripten_deps as deps
from workspace import prepare_workspace


def archive_bytes(files):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w:gz") as archive:
        for name, contents in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(contents)
            archive.addfile(member, io.BytesIO(contents))
    return data.getvalue()


class EmscriptenDependencyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="emscripten dependencies ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.cache = self.root / "cache"
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "pristine").write_text("unchanged source")
        self.sources = {"codex": self.source}
        self.assets = self.root / "patches"
        self.assets.mkdir()
        self.crates = {}
        self.archives = {}
        for name in ("tokio", "mio", "socket2", "tokio-util", "socket2_05", "nix", "serial2", "opentelemetry-otlp", "nix_031"):
            package_name = deps.PACKAGE_NAMES.get(name, name)
            version = {"socket2": "0.6.5", "socket2_05": "0.5.10", "nix": "0.28.0", "nix_031": "0.31.3"}.get(name, "1.0.0")
            data = archive_bytes({
                f'{package_name}-{version}/Cargo.toml':
                    f'[package]\nname="{package_name}"\nversion="{version}"\n'.encode(),
                f'{package_name}-{version}/src/lib.rs': b'pub fn original() {}\n',
                f'{package_name}-{version}/LICENSE': b'upstream license\n',
            })
            self.crates[name] = (version, hashlib.sha256(data).hexdigest())
            self.archives[f"{package_name}-{version}.crate"] = data
            if name == "socket2":
                continue
            (self.assets / f"{name}.patch").write_text(
                f'--- a/{name}/src/lib.rs\n+++ b/{name}/src/lib.rs\n'
                '@@ -1 +1 @@\n-pub fn original() {}\n+pub fn adapted() {}\n')
        self.enterContext(patch.object(deps, "CRATES", self.crates))
        self.enterContext(patch.object(deps, "ASSETS", self.assets))
        self.network = self.enterContext(patch("urllib.request.urlopen", side_effect=lambda url, **kw:
                                               io.BytesIO(self.archives[url.rsplit("/", 1)[-1]])))

    def prepare(self):
        return deps.prepare_emscripten_dependencies(self.cache, self.sources)

    def test_map_integrates_with_workspace_and_preserves_sources(self):
        paths = self.prepare()
        self.assertEqual(set(paths), {"tokio", "mio", "socket2", "tokio-util", "socket2_05", "nix", "serial2", "opentelemetry-otlp", "nix_031"})
        for name, path in paths.items():
            self.assertTrue(path.is_absolute())
            self.assertTrue(path.is_relative_to(self.cache.resolve()))
            self.assertEqual((path / "src/lib.rs").read_text(),
                             "pub fn original() {}\n" if name == "socket2" else "pub fn adapted() {}\n")
            self.assertEqual((path / "LICENSE").read_text(), "upstream license\n")
            self.assertEqual(tomllib.loads((path / "Cargo.toml").read_text())["package"],
                             {"name": deps.PACKAGE_NAMES.get(name, name),
                              "version": self.crates[name][0]})
        urls = [call.args[0] for call in self.network.call_args_list]
        self.assertIn("https://static.crates.io/crates/socket2/socket2-0.5.10.crate", urls)
        self.assertIn("https://static.crates.io/crates/socket2/socket2-0.6.5.crate", urls)
        self.assertFalse(any("socket2_05" in url for url in urls))
        self.assertIn("https://static.crates.io/crates/nix/nix-0.28.0.crate", urls)
        self.assertIn("https://static.crates.io/crates/nix/nix-0.31.3.crate", urls)
        self.assertFalse(any("nix_031" in url for url in urls))
        copied = self.root / "copied/codex-rs"
        copied.mkdir(parents=True)
        (copied / "Cargo.toml").write_text('[workspace]\nmembers=[]\n[workspace.package]\nversion="0.0.0"\n[profile.release]\n')
        engine = self.root / "engine"
        engine.mkdir()
        (engine / "Cargo.toml").write_text('[package]\nname="fixture"\nversion="1.0.0"\n')
        workspace = prepare_workspace(copied.parent, engine, paths, "0.162.1")
        manifest = tomllib.loads((workspace / "Cargo.toml").read_text())
        self.assertEqual(manifest["patch"]["crates-io"], {
            name: {"path": str(path), **({"package": deps.PACKAGE_NAMES[name]} if name in deps.PACKAGE_NAMES else {})}
            for name, path in paths.items()})
        self.assertEqual(list(self.source.iterdir()), [self.source / "pristine"])
        self.assertEqual((self.source / "pristine").read_text(), "unchanged source")

    def test_reuse_needs_no_network_or_patch_application(self):
        paths = self.prepare()
        self.network.side_effect = AssertionError("network during reuse")
        with patch.object(deps, "patch_series", side_effect=AssertionError("patch during reuse")):
            self.assertEqual(paths, self.prepare())
        self.assertEqual(self.network.call_count, 9)

    def test_patch_changes_select_a_new_stage(self):
        before = self.prepare()
        patch_file = self.assets / "mio.patch"
        patch_file.write_text(patch_file.read_text().replace("adapted", "changed"))
        after = self.prepare()
        self.assertNotEqual(before, after)
        self.assertIn("changed", (after["mio"] / "src/lib.rs").read_text())
        self.assertIn("adapted", (before["mio"] / "src/lib.rs").read_text())

    def test_changed_cached_source_is_rejected(self):
        paths = self.prepare()
        (paths["socket2_05"] / "src/lib.rs").write_text("changed after preparation")
        with self.assertRaisesRegex(ValueError, "dependency cache changed"):
            self.prepare()

    def test_wrong_cached_package_is_rejected(self):
        paths = self.prepare()
        manifest = paths["tokio"] / "Cargo.toml"
        manifest.write_text(manifest.read_text().replace('version="1.0.0"', 'version="2.0.0"'))
        with self.assertRaisesRegex(ValueError, "expected tokio 1.0.0"):
            self.prepare()

    def test_alias_archive_requires_the_real_package_name_and_pinned_version(self):
        for name, version in (("socket2_05", "0.5.10"), ("socket2", "0.5.9")):
            with self.subTest(name=name, version=version):
                data = archive_bytes({
                    'socket2-0.5.10/Cargo.toml':
                        f'[package]\nname="{name}"\nversion="{version}"\n'.encode(),
                    'socket2-0.5.10/src/lib.rs': b'pub fn original() {}\n',
                })
                self.archives["socket2-0.5.10.crate"] = data
                self.crates["socket2_05"] = ("0.5.10", hashlib.sha256(data).hexdigest())
                with self.assertRaisesRegex(ValueError, "expected socket2 0.5.10"):
                    self.prepare()
                self.assertFalse(list(self.cache.glob("emscripten-deps-*")))
                self.assertFalse(list(self.cache.glob(".emscripten-deps-*")))
                (self.cache / "downloads/socket2-0.5.10.crate").unlink()

    def test_alias_mapping_is_part_of_the_cache_identity(self):
        identity = deps._identity()
        with patch.object(deps, "PACKAGE_NAMES", {}):
            self.assertNotEqual(identity, deps._identity())

    def test_bad_checksum_cannot_publish_a_stage(self):
        self.archives["mio-1.0.0.crate"] += b"corrupt"
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            self.prepare()
        self.assertFalse(list(self.cache.glob("emscripten-deps-*")))
        self.assertFalse(list(self.cache.glob(".emscripten-deps-*")))

    def test_failed_patch_cannot_publish_a_stage_and_can_retry(self):
        with patch.object(deps, "patch_series", side_effect=RuntimeError("patch failed")):
            with self.assertRaisesRegex(RuntimeError, "patch failed"):
                self.prepare()
        self.assertFalse(list(self.cache.glob("emscripten-deps-*")))
        self.assertFalse(list(self.cache.glob(".emscripten-deps-*")))
        self.assertEqual(set(self.prepare()), {"mio", "tokio", "socket2", "tokio-util", "socket2_05", "nix", "serial2", "opentelemetry-otlp", "nix_031"})

    def test_new_nix_patch_keeps_the_previous_stage_immutable(self):
        with patch.dict(self.crates, clear=False):
            self.crates.pop("nix")
            with patch.object(deps, "_patches", return_value=[
                    self.assets / f"{name}.patch"
                    for name in ("mio", "tokio", "tokio-util", "socket2_05")]):
                previous = self.prepare()
        previous_root = previous["mio"].parent
        before = {str(path.relative_to(previous_root)): path.read_bytes()
                  for path in previous_root.rglob("*") if path.is_file()}
        current = self.prepare()
        self.assertNotEqual(previous_root, current["mio"].parent)
        self.assertIn("nix", current)
        (current["nix"] / "src/lib.rs").write_text("tampered nix")
        with self.assertRaisesRegex(ValueError, "dependency cache changed"):
            self.prepare()
        self.assertEqual(before, {str(path.relative_to(previous_root)): path.read_bytes()
                                 for path in previous_root.rglob("*") if path.is_file()})

    def test_new_otlp_patch_keeps_the_serial_stage_immutable(self):
        with patch.dict(self.crates, clear=False):
            self.crates.pop("opentelemetry-otlp")
            with patch.object(deps, "_patches", return_value=[
                    self.assets / f"{name}.patch"
                    for name in ("mio", "tokio", "tokio-util", "socket2_05", "nix", "serial2")]):
                previous = self.prepare()
        previous_root = previous["serial2"].parent
        before = {str(path.relative_to(previous_root)): path.read_bytes()
                  for path in previous_root.rglob("*") if path.is_file()}
        current = self.prepare()
        self.assertNotEqual(previous_root, current["serial2"].parent)
        self.assertIn("opentelemetry-otlp", current)
        self.assertEqual(before, {str(path.relative_to(previous_root)): path.read_bytes()
                                 for path in previous_root.rglob("*") if path.is_file()})
        (current["opentelemetry-otlp"] / "src/lib.rs").write_text("tampered otlp")
        with self.assertRaisesRegex(ValueError, "dependency cache changed"):
            self.prepare()

    def test_new_nix_alias_keeps_both_versions_and_the_previous_stage_immutable(self):
        with patch.dict(self.crates, clear=False):
            self.crates.pop("nix_031")
            with patch.object(deps, "_patches", return_value=[
                    self.assets / f"{name}.patch" for name in
                    ("mio", "tokio", "tokio-util", "socket2_05", "nix", "serial2", "opentelemetry-otlp")]):
                previous = self.prepare()
        previous_root = previous["nix"].parent
        before = {str(path.relative_to(previous_root)): path.read_bytes()
                  for path in previous_root.rglob("*") if path.is_file()}
        current = self.prepare()
        self.assertNotEqual(previous_root, current["nix"].parent)
        for alias, version in (("nix", "0.28.0"), ("nix_031", "0.31.3")):
            package = tomllib.loads((current[alias] / "Cargo.toml").read_text())["package"]
            self.assertEqual(package, {"name": "nix", "version": version})
        self.assertEqual(before, {str(path.relative_to(previous_root)): path.read_bytes()
                                 for path in previous_root.rglob("*") if path.is_file()})
        (current["nix_031"] / "src/lib.rs").write_text("tampered nix alias")
        with self.assertRaisesRegex(ValueError, "dependency cache changed"):
            self.prepare()

    def test_missing_patch_cannot_silently_return_pristine_crates(self):
        (self.assets / "mio.patch").unlink()
        with self.assertRaisesRegex(ValueError, "missing Emscripten dependency patch"):
            self.prepare()
        self.network.assert_not_called()

    def test_cache_inside_source_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "inside a source checkout"):
            deps.prepare_emscripten_dependencies(self.source / "cache", self.sources)
        self.network.assert_not_called()

    def test_symlink_stage_and_symlink_content_are_rejected(self):
        paths = self.prepare()
        root = paths["mio"].parent
        moved = root.with_name("moved")
        root.rename(moved)
        root.symlink_to(moved, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "redirect to sources"):
            self.prepare()
        root.unlink()
        moved.rename(root)
        (paths["mio"] / "src/link").symlink_to(self.source / "pristine")
        with self.assertRaisesRegex(ValueError, "must not contain symlinks"):
            self.prepare()

    def test_marker_identity_mismatch_is_rejected(self):
        paths = self.prepare()
        marker = paths["mio"].parent / ".ready"
        ready = json.loads(marker.read_text())
        ready["identity"] = "wrong"
        marker.write_text(json.dumps(ready))
        with self.assertRaisesRegex(ValueError, "dependency cache changed"):
            self.prepare()


if __name__ == "__main__":
    unittest.main()
