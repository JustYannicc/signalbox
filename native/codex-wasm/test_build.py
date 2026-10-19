# pyright: reportImplicitRelativeImport=false
import argparse
from contextlib import ExitStack, redirect_stderr
import hashlib
import io
import json
from pathlib import Path
import tempfile
import tomllib
import unittest
from unittest.mock import patch

import build

TARGET = "wasm32-wasip1"
UNSUPPORTED_TARGETS = ("wasm32-unknown-emscripten", "wasm32-wasip1-threads",
                       "wasm32-wasip2", "wasm32-unknown-unknown", "x86_64-unknown-linux-gnu")


class EngineOutputTests(unittest.TestCase):
    def test_actual_wasi_cargo_output_needs_no_glue(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            module = root / TARGET / "release/signalbox-codex-engine.wasm"
            module.parent.mkdir(parents=True)
            module.write_bytes(b"\0asm\x01\0\0\0")
            self.assertEqual(build.engine_outputs(root), module)

    def test_missing_module_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, "without producing signalbox-codex-engine.wasm"):
                build.engine_outputs(Path(temporary))

    def test_directory_is_not_an_engine_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / TARGET / "release/signalbox-codex-engine.wasm").mkdir(parents=True)
            with self.assertRaisesRegex(ValueError, "without producing"):
                build.engine_outputs(root)


class TargetTests(unittest.TestCase):
    def test_release_pin_supports_only_wasip1(self):
        self.assertEqual(build.read_pin(build.ROOT / "upstream.json")["targets"], [TARGET])

    def test_unsupported_targets_are_rejected_before_reading_inputs(self):
        with patch.object(build, "read_pin") as read_pin, patch.object(build, "checkout") as checkout:
            for target in UNSUPPORTED_TARGETS:
                with self.subTest(target=target), self.assertRaisesRegex(ValueError, "Unsupported build target"):
                    build.build(argparse.Namespace(target=target))
            read_pin.assert_not_called()
            checkout.assert_not_called()

    def test_pin_can_disable_the_supported_target(self):
        with patch.object(build, "read_pin", return_value={"targets": []}), \
                patch.object(build, "checkout") as checkout:
            with self.assertRaisesRegex(ValueError, "not enabled by the release pin"):
                build.build(argparse.Namespace(target=TARGET, pin=Path("unused.json")))
            checkout.assert_not_called()

    def test_cli_defaults_to_wasip1(self):
        with patch.object(build.sys, "argv", ["build.py"]), patch.object(build, "build") as run:
            build.main()
            self.assertEqual(run.call_args.args[0].target, TARGET)

    def test_cli_rejects_unsupported_targets(self):
        with patch.object(build, "build") as run, redirect_stderr(io.StringIO()):
            for target in UNSUPPORTED_TARGETS:
                with self.subTest(target=target), \
                        patch.object(build.sys, "argv", ["build.py", "--target", target]), \
                        self.assertRaises(SystemExit) as error:
                    build.main()
                self.assertEqual(error.exception.code, 2)
            run.assert_not_called()


class ArtifactTests(unittest.TestCase):
    def test_wasi_packaging_preserves_static_loader_and_integrity_manifest(self):
        pin = build.read_pin(build.ROOT / "upstream.json")
        module = b"\0asm\x01\0\0\0"
        metadata = {"packages": [{"id": "engine", "name": "signalbox-codex-engine"},
                                  {"id": "client", "name": "codex-app-server-client"}],
                    "resolve": {"nodes": [
                        {"id": "engine", "deps": [{"pkg": "client", "dep_kinds": [{"kind": None}]}]},
                        {"id": "client", "deps": []}]}}
        inventory = {"imports": [], "exports": []}
        with tempfile.TemporaryDirectory() as temporary, ExitStack() as mocks:
            root = Path(temporary).resolve()
            args = argparse.Namespace(target=TARGET, pin=build.ROOT / "upstream.json",
                                      cache=root / "cache", output=root / "output",
                                      prepare_only=False, check=False)
            output = args.output / f"{pin['version']}-{pin['commit'][:12]}" / TARGET
            workspace = output / "source/codex-rs"

            def prepare_workspace(*_):
                workspace.mkdir(parents=True)
                (workspace / "Cargo.lock").write_text("version = 4\npackage = []\n")
                return workspace

            def command(argv, *, env, **_):
                if argv[0] == "cargo":
                    if argv[1] == "metadata":
                        return json.dumps(metadata)
                    binary = Path(env["CARGO_TARGET_DIR"]) / TARGET / "release/signalbox-codex-engine.wasm"
                    binary.parent.mkdir(parents=True)
                    binary.write_bytes(module)
                elif argv[0] == "wasm-opt":
                    Path(argv[-1]).write_bytes(Path(argv[-3]).read_bytes())
                elif argv[0] == "node":
                    return json.dumps(inventory)
                else:
                    self.fail(f"unexpected external command: {argv}")
                return ""

            replacements = {
                "checkout": lambda cache, name, spec: root / "inputs" / name,
                "verify_checkout": lambda *_: "pristine-source-hash",
                "export_tree": lambda *_: None,
                "apply_overlay": lambda *_: [],
                "apply_websocket_overlay": lambda *_: [],
                "prepare_dependencies": lambda *_: {},
                "prepare_wasi_reactor": lambda cache, references, patches: patches,
                "prepare_url_dependency": lambda *_: {},
                "prepare_sqlite_dependencies": lambda cache, references, patches: patches,
                "prepare_workspace": prepare_workspace,
                "prepare_wasi_toolchain": lambda *_: {"CARGO": "cargo", "RUSTUP_TOOLCHAIN": pin["rust"]},
                "prepare_binaryen": lambda *_: "wasm-opt",
                "command": command,
            }
            for name, replacement in replacements.items():
                mocks.enter_context(patch.object(build, name, side_effect=replacement))
            build.build(args)
            artifact = output / "artifact"
            self.assertEqual({path.name for path in artifact.iterdir()},
                             {"engine.wasm", "loader.mjs", "Cargo.lock", "manifest.json"})
            self.assertEqual((artifact / "loader.mjs").read_bytes(), (build.ROOT / "loader.mjs").read_bytes())
            manifest = json.loads((artifact / "manifest.json").read_text())
            self.assertEqual(manifest["target"], TARGET)
            self.assertEqual(manifest["moduleSha256"], hashlib.sha256(module).hexdigest())
            self.assertEqual(manifest["moduleBytes"], len(module))
            self.assertEqual(manifest["moduleBudgetBytes"], 60_000_000)
            self.assertTrue(manifest["moduleBudgetPassed"])
            self.assertEqual(manifest["proof"], {"localWorkerd": "pending", "deployedDO": "pending"})
            self.assertEqual(manifest["cargoLockSha256"],
                             hashlib.sha256((artifact / "Cargo.lock").read_bytes()).hexdigest())
            for name, entry in manifest["files"].items():
                data = (artifact / name).read_bytes()
                self.assertEqual(entry, {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)})
            report = json.loads((output / "build-report.json").read_text())
            self.assertEqual(report["status"], "built-unverified")
            self.assertEqual(report["sourceSha256Before"], report["sourceSha256After"])
            self.assertEqual(set(report["referenceSha256"]), set(pin["references"]))
            self.assertEqual(report["packages"], ["codex-app-server-client", "signalbox-codex-engine"])


class PreparationTests(unittest.TestCase):
    def test_wasi_stages_reach_generated_workspace_without_building(self):
        pin = build.read_pin(build.ROOT / "upstream.json")
        with tempfile.TemporaryDirectory() as temporary, ExitStack() as mocks:
            root = Path(temporary).resolve()
            args = argparse.Namespace(target=TARGET, pin=build.ROOT / "upstream.json",
                                      cache=root / "cache", output=root / "output",
                                      prepare_only=True, check=False)
            output = args.output / f"{pin['version']}-{pin['commit'][:12]}" / TARGET
            paths = {}
            for name in ("libc", "tokio", "mio", "url", "sqlx-sqlite"):
                crate = root / "stages" / name
                crate.mkdir(parents=True)
                (crate / "Cargo.toml").write_text(f'[package]\nname="{name}"\nversion="1.0.0"\n')
                paths[name] = crate
            old_tokio = root / "old-tokio"
            base = {"libc": paths["libc"], "tokio": old_tokio}
            changes = [{"path": "core.rs", "rule": "core"}]
            websocket_changes = [{"path": "websocket.rs", "rule": "websocket"}]

            def export_tree(source, copied, commit):
                workspace = copied / "codex-rs"
                workspace.mkdir(parents=True)
                (workspace / "Cargo.toml").write_text(
                    '[workspace]\nmembers=[]\n[workspace.package]\nversion="0.0.0"\n[profile.release]\n')

            def reactor(cache, references, patches):
                self.assertEqual(cache, args.cache / "reactor")
                self.assertEqual(patches, base)
                return {**patches, "tokio": paths["tokio"], "mio": paths["mio"]}

            def sqlite(cache, references, patches):
                self.assertEqual(cache, args.cache / "sqlite")
                self.assertEqual(patches, {name: paths[name] for name in ("libc", "tokio", "mio", "url")})
                return {**patches, "sqlx-sqlite": paths["sqlx-sqlite"]}

            replacements = {
                "checkout": lambda cache, name, spec: root / "inputs" / name,
                "verify_checkout": lambda *_: "pristine-source-hash",
                "export_tree": export_tree,
                "apply_overlay": lambda *_: list(changes),
                "apply_websocket_overlay": lambda *_: websocket_changes,
                "prepare_dependencies": lambda *_: base,
                "prepare_wasi_reactor": reactor,
                "prepare_url_dependency": lambda *_: {"url": paths["url"]},
                "prepare_sqlite_dependencies": sqlite,
                "prepare_wasi_toolchain": AssertionError("prepare-only must not prepare a toolchain"),
                "command": AssertionError("prepare-only must not run Cargo or an engine"),
            }
            for name, replacement in replacements.items():
                mocks.enter_context(patch.object(build, name, side_effect=replacement))
            build.build(args)
            manifest = tomllib.loads((output / "source/codex-rs/Cargo.toml").read_text())
            self.assertEqual(manifest["patch"]["crates-io"],
                             {name: {"path": str(path)} for name, path in paths.items()})
            self.assertEqual(base["tokio"], old_tokio)
            report = json.loads((output / "build-report.json").read_text())
            self.assertEqual(report["status"], "prepared")
            self.assertEqual(report["overlay"], changes + websocket_changes)
            self.assertEqual(report["sourceSha256Before"], report["sourceSha256After"])


if __name__ == "__main__":
    unittest.main()
