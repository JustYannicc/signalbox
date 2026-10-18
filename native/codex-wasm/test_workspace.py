# pyright: reportImplicitRelativeImport=false
from pathlib import Path
import json
import tempfile
import tomllib
import unittest

from workspace import patch_lock_updates, prepare_workspace, verify_engine_graph, write_toml


class WorkspaceTests(unittest.TestCase):
    def test_cargo_target_and_patch_names_round_trip(self):
        data = {"workspace": {"members": ["engine"], "resolver": "3"},
                "target": {'cfg(target_os = "wasi")': {"dependencies": {"libc": "0.2"}}},
                "patch": {"crates-io": {"tokio": {"path": "/wrapper/tokio"}}},
                "profile": {"release": {"lto": "thin", "debug": False}}}
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "Cargo.toml"
            write_toml(path, data)
            self.assertEqual(tomllib.loads(path.read_text()), data)

    def test_only_engine_dependency_closure_is_checked(self):
        metadata = json.loads(json.dumps({
            "packages": [{"id": "engine", "name": "signalbox-codex-engine"},
                         {"id": "client", "name": "codex-app-server-client"},
                         {"id": "tui", "name": "codex-tui"}],
            "resolve": {"nodes": [
                {"id": "engine", "deps": [{"pkg": "client", "dep_kinds": [{"kind": None}]}]},
                {"id": "client", "deps": [{"pkg": "tui", "dep_kinds": [{"kind": "dev"}]}]},
                {"id": "tui", "deps": []},
            ]},
        }))
        self.assertEqual(verify_engine_graph(metadata),
                         ["codex-app-server-client", "signalbox-codex-engine"])
        metadata["resolve"]["nodes"][1]["deps"][0]["dep_kinds"][0]["kind"] = None
        with self.assertRaisesRegex(ValueError, "codex-tui"):
            verify_engine_graph(metadata)

    def test_wrapper_patch_is_selected_without_replacing_other_major_versions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            patch = root / "socket2"
            patch.mkdir()
            (patch / "Cargo.toml").write_text('[package]\nname="socket2"\nversion="0.6.5"\n')
            (root / "Cargo.lock").write_text(
                '[[package]]\nname="socket2"\nversion="0.6.3"\nsource="registry+test"\n'
                '[[package]]\nname="socket2"\nversion="0.5.10"\nsource="registry+test"\n')
            self.assertEqual(patch_lock_updates(root, {"socket2": patch}),
                             [("socket2@0.6.3", "0.6.5")])

    def test_two_socket2_lines_keep_their_package_identity_and_lock_updates(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source/codex-rs"
            source.mkdir(parents=True)
            (source / "Cargo.toml").write_text(
                '[workspace]\nmembers=[]\n[workspace.package]\nversion="0.0.0"\n[profile.release]\n')
            engine = root / "engine"
            engine.mkdir()
            (engine / "Cargo.toml").write_text('[package]\nname="fixture"\nversion="1.0.0"\n')
            patches = {}
            for alias, version in (("socket2_05", "0.5.10"), ("socket2", "0.6.5")):
                path = root / alias
                path.mkdir()
                (path / "Cargo.toml").write_text(
                    f'[package]\nname="socket2"\nversion="{version}"\n')
                patches[alias] = path
            prepare_workspace(source.parent, engine, patches, "0.162.1")
            manifest = tomllib.loads((source / "Cargo.toml").read_text())
            self.assertEqual(manifest["patch"]["crates-io"], {
                "socket2_05": {"package": "socket2", "path": str(patches["socket2_05"].resolve())},
                "socket2": {"path": str(patches["socket2"].resolve())},
            })
            (source / "Cargo.lock").write_text("".join(
                f'[[package]]\nname="socket2"\nversion="{version}"\nsource="{origin}"\n'
                for version, origin in (("0.5.9", "registry+test"),
                                        ("0.6.3", "registry+test"),
                                        ("0.4.10", "registry+test"),
                                        ("0.5.8", "git+test"))))
            expected = [("socket2@0.5.9", "0.5.10"), ("socket2@0.6.3", "0.6.5")]
            self.assertEqual(patch_lock_updates(source, patches), expected)
            self.assertEqual(patch_lock_updates(source, dict(reversed(list(patches.items())))), expected)
            (patches["socket2"] / "Cargo.toml").write_text(
                '[package]\nname="socket2"\nversion="0.5.11"\n')
            with self.assertRaisesRegex(ValueError, "Ambiguous patch versions for socket2 0.5"):
                patch_lock_updates(source, patches)


if __name__ == "__main__":
    unittest.main()
