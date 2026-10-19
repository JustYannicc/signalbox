"""Run with CODEX_OVERLAY_TEST_SOURCE pointing at pristine rust-v0.162.1 for integration."""

import hashlib
import os
import shutil
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest.mock import patch

import overlay
from compatibility.tokens import tokenize, values

PLATFORM = '''use crate::GitToolingError;
use std::path::Path;

#[cfg(unix)]
pub fn create_symlink(
    _source: &Path,
    link_target: &Path,
    destination: &Path,
) -> Result<(), GitToolingError> {
    std::os::unix::fs::symlink(link_target, destination)?;
    Ok(())
}

#[cfg(windows)]
pub fn create_symlink(
    source: &Path,
    link_target: &Path,
    destination: &Path,
) -> Result<(), GitToolingError> {
    if source.is_dir() {
        std::os::windows::fs::symlink_dir(link_target, destination)?;
    } else {
        std::os::windows::fs::symlink_file(link_target, destination)?;
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
compile_error!("codex-git symlink support is only implemented for Unix and Windows");
'''
TARGET = "wasm32-wasip1"
PLATFORM_PATH = "codex-rs/git-utils/src/platform.rs"


def snapshot(root):
    return {str(path.relative_to(root)): path.read_bytes()
            for path in root.rglob("*") if path.is_file()}


class OverlayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / PLATFORM_PATH
        self.path.parent.mkdir(parents=True)
        self.path.write_text(PLATFORM)
        self.rule = next(rule for rule in overlay._rules() if rule["rule"] == "symlink-arm")
        mocked = patch.object(overlay, "_rules", return_value=[self.rule])
        mocked.start()
        self.addCleanup(mocked.stop)

    def apply(self):
        return overlay.apply_overlay(self.root, TARGET)

    def test_adds_only_wasi_arm_and_is_idempotent(self):
        changes = self.apply()
        self.assertEqual(changes, [{"path": PLATFORM_PATH, "rule": "symlink-arm"}])
        result = self.path.read_text()
        self.assertIn("std::os::wasi::fs::symlink_path", result)
        self.assertIn("std::os::unix::fs::symlink", result)
        self.assertIn("std::os::windows::fs::symlink_file", result)
        self.assertEqual(self.apply(), [])
        self.assertEqual(self.path.read_text(), result)

    def test_comment_and_whitespace_drift_survives(self):
        source = PLATFORM.replace('#[cfg(not(any(unix, windows)))]',
                                  '# [ cfg ( not ( any ( unix, /* nested /* ok */ */ windows ) ) ) ]')
        source = source.replace('compile_error!', '// retained comment\ncompile_error !')
        self.path.write_text(source)
        self.apply()
        self.assertIn('// retained comment', self.path.read_text())
        self.assertIn('/* nested /* ok */ */', self.path.read_text())
        self.assertEqual(self.apply(), [])

    def test_changed_cfg_fails_without_writing(self):
        self.path.write_text(PLATFORM.replace('not(any(unix, windows))', 'not(unix)'))
        original = snapshot(self.root)
        with self.assertRaisesRegex(overlay.OverlayError, 'symlink-arm.*#1072'):
            self.apply()
        self.assertEqual(snapshot(self.root), original)

    def test_changed_compile_error_fails(self):
        self.path.write_text(PLATFORM.replace('implemented for Unix and Windows', 'now different'))
        with self.assertRaises(overlay.OverlayError):
            self.apply()

    def test_ambiguous_structure_fails(self):
        self.path.write_text(PLATFORM + PLATFORM)
        with self.assertRaisesRegex(overlay.OverlayError, 'found 2/0'):
            self.apply()

    def test_upstream_equivalent_arm_is_not_applied_again(self):
        old = overlay._text(self.rule, "before")
        new = overlay._text(self.rule, "after")
        self.path.write_text(PLATFORM.replace(old, new))
        original = self.path.read_bytes()
        self.assertEqual(self.apply(), [])
        self.assertEqual(self.path.read_bytes(), original)

    def test_different_upstream_wasi_arm_is_rejected(self):
        self.path.write_text(PLATFORM + '\n#[cfg(target_os = "wasi")]\n'
                             'pub fn create_symlink() { todo!() }\n')
        with self.assertRaisesRegex(overlay.OverlayError, 'unrecognized WASI arm'):
            self.apply()

    def test_duplicate_old_and_new_arms_are_rejected(self):
        self.apply()
        self.path.write_text(self.path.read_text() + PLATFORM)
        with self.assertRaisesRegex(overlay.OverlayError, 'both old and WASI'):
            self.apply()

    def test_validation_failure_is_atomic_across_files(self):
        broken = {**self.rule, "path": "codex-rs/later.rs"}
        (self.root / broken["path"]).write_text('mod changed;\n')
        original = snapshot(self.root)
        with patch.object(overlay, "_rules", return_value=[self.rule, broken]), self.assertRaises(overlay.OverlayError):
            self.apply()
        self.assertEqual(snapshot(self.root), original)

    def test_checkout_is_refused(self):
        for is_dir in (False, True):
            with self.subTest(directory=is_dir):
                marker = self.root / '.git'
                marker.mkdir() if is_dir else marker.write_text('gitdir: elsewhere\n')
                with self.assertRaisesRegex(overlay.OverlayError, 'without .git'):
                    self.apply()
                marker.rmdir() if is_dir else marker.unlink()

    def test_hardlinks_and_symlinks_are_refused(self):
        backup = self.root / 'original.rs'
        self.path.rename(backup)
        for hardlink in (False, True):
            with self.subTest(hardlink=hardlink):
                os.link(backup, self.path) if hardlink else self.path.symlink_to(backup)
                with self.assertRaises(overlay.OverlayError):
                    self.apply()
                self.path.unlink()
        self.assertEqual(backup.read_text(), PLATFORM)

    def test_symlinked_parent_and_root_are_refused(self):
        moved = self.root / 'moved'
        self.path.parent.rename(moved)
        self.path.parent.symlink_to(moved, target_is_directory=True)
        with self.assertRaises(overlay.OverlayError):
            self.apply()
        link = self.root / 'copy-link'
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(overlay.OverlayError):
            overlay.apply_overlay(link, TARGET)

    def test_target_is_checked_before_writing(self):
        original = snapshot(self.root)
        for target in ('x86_64-unknown-linux-gnu', 'wasm32-wasip1-threads',
                       'wasm32-wasip2', 'wasm32-unknown-unknown'):
            with self.subTest(target=target):
                with self.assertRaisesRegex(overlay.OverlayError, 'unsupported overlay target'):
                    overlay.apply_overlay(self.root, target)
                self.assertEqual(snapshot(self.root), original)

    def test_strings_and_comments_do_not_impersonate_structure(self):
        self.path.write_text('const EXAMPLE: &str = r###"' + PLATFORM + '"###;\n')
        with self.assertRaises(overlay.OverlayError):
            self.apply()

    def test_token_reader_handles_literals_lifetimes_and_comments(self):
        source = 'r##"/* x */"## "// x" b\'x\' \'_ /* a /* b */ c */ &\'a Path'
        self.assertEqual(values(source), ('r##"/* x */"##', '"// x"', "b'x'", "'", '_', '&', "'", 'a', 'Path'))
        with self.assertRaisesRegex(ValueError, 'unterminated'):
            tokenize('/* never closed')


@unittest.skipUnless(os.environ.get('CODEX_OVERLAY_TEST_SOURCE'), 'set CODEX_OVERLAY_TEST_SOURCE for official-source integration')
class OfficialSourceTests(unittest.TestCase):
    def setUp(self):
        self.source = Path(os.environ['CODEX_OVERLAY_TEST_SOURCE'])
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.rules = overlay._rules()
        self.originals = {}
        for relative in {rule['path'] for rule in self.rules if 'asset' not in rule}:
            source = self.source / relative
            self.originals[relative] = hashlib.sha256(source.read_bytes()).hexdigest()
            dest = self.root / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, dest)

    def test_official_surface_and_original_checkout_unchanged(self):
        changes = overlay.apply_overlay(self.root, TARGET)
        self.assertEqual(len(changes), len(self.rules))
        self.assertEqual(overlay.apply_overlay(self.root, TARGET), [])
        for relative, original in self.originals.items():
            self.assertEqual(hashlib.sha256((self.source / relative).read_bytes()).hexdigest(), original)
        http = tomllib.loads((self.root / 'codex-rs/http-client/Cargo.toml').read_text())
        self.assertNotIn('native-tls', http['dependencies'])
        self.assertEqual(http['target']['cfg(not(target_os = "wasi"))']['dependencies']['native-tls'], '0.2')
        mxc = tomllib.loads((self.root / 'codex-rs/mxc-sandbox/Cargo.toml').read_text())
        self.assertNotIn('wxc_common', mxc['dependencies'])
        self.assertIn('wxc_common', mxc['target']['cfg(windows)']['dependencies'])
        # No CLI entrypoint, WebSocket policy, or code-mode policy is in the surface.
        self.assertFalse(any('/exec/' in item['path'] for item in changes))

    def test_all_rules_accept_comment_and_whitespace_drift(self):
        for path in self.root.rglob('*'):
            if path.is_file():
                toml = path.suffix == '.toml'
                source = path.read_text()
                tokens = tokenize(source, toml)
                if toml:
                    path.write_text('\n# drift\n'.join(source.splitlines()) + '\n')
                else:
                    gap = ' /* drift /* nested */ */\n '
                    path.write_text(gap.join(token.value for token in tokens) + '\n')
        overlay.apply_overlay(self.root, TARGET)
        self.assertEqual(overlay.apply_overlay(self.root, TARGET), [])
        for path in self.root.rglob('Cargo.toml'):
            tomllib.loads(path.read_text())

    def test_late_shape_failure_does_not_create_files(self):
        path = self.root / 'codex-rs/utils/path-utils/src/system_commands.rs'
        path.write_text(path.read_text().replace('fn system_directories()', 'fn renamed_directories()'))
        original = snapshot(self.root)
        with self.assertRaisesRegex(overlay.OverlayError, '#1072'):
            overlay.apply_overlay(self.root, TARGET)
        self.assertEqual(snapshot(self.root), original)
        self.assertFalse((self.root / 'codex-rs/exec-server/src/no_follow/wasi.rs').exists())

    def test_conflicting_manifest_gate_is_rejected(self):
        path = self.root / 'codex-rs/http-client/Cargo.toml'
        with path.open('a') as output:
            output.write('\n[target.\'cfg(not(target_os = "wasi"))\'.dependencies]\nnative-tls = "0.3"\n')
        original = snapshot(self.root)
        with self.assertRaisesRegex(overlay.OverlayError, 'unrecognized WASI arm'):
            overlay.apply_overlay(self.root, TARGET)
        self.assertEqual(snapshot(self.root), original)

    def test_existing_conflicting_module_is_atomic(self):
        new_file = self.root / 'codex-rs/exec-server/src/no_follow/wasi.rs'
        new_file.write_text('pub fn unexpected() {}\n')
        original = snapshot(self.root)
        with self.assertRaisesRegex(overlay.OverlayError, 'existing WASI module differs'):
            overlay.apply_overlay(self.root, TARGET)
        self.assertEqual(snapshot(self.root), original)


if __name__ == '__main__':
    unittest.main()
