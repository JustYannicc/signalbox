"""WASI search validates complete upstream source files before modifying them."""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import overlay  # pyright: ignore[reportImplicitRelativeImport]

@contextmanager
def fixture():
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        rules = json.loads((Path(__file__).parent / 'compatibility/file-search.json').read_text())['rules']
        hashes = {}
        for name in dict.fromkeys(rule['path'] for rule in rules if 'asset' not in rule):
            group = [rule for rule in rules if rule['path'] == name]
            source = '\n'.join(overlay._text(rule, 'before') for rule in group)
            source += '\nfn unchanged_walker() { builder.hidden(false); }\n'
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(source)
            output = source
            for rule in group:
                output = overlay._replace(output, rule)
            hashes[name] = {'source_sha256': hashlib.sha256(source.encode()).hexdigest(),
                            'patched_sha256': hashlib.sha256(output.encode()).hexdigest()}
        path = root / rules[0]['path']
        with patch.object(overlay, '_rules', return_value=rules), patch.object(overlay, '_source_hashes', return_value=hashes):
            yield root, rules, path

class FileSearchTests(unittest.TestCase):
    def test_async_session_and_native_workers_remain_separate(self):
        with fixture() as (root, rules, path):
            self.assertEqual(len(overlay.apply_overlay(root, 'wasm32-wasip1')), len(rules))
            result = path.read_text()
            self.assertIn('wasi::search(inner.clone(), query, generation).await', result)
            self.assertIn('#[cfg(not(target_os = "wasi"))]', result)
            self.assertIn('thread::spawn(move || matcher_worker', result)
            module = (path.parent / 'wasi.rs').read_text()
            for forbidden in ['Nucleo::new', 'thread::spawn', 'build_parallel', 'ThreadPool']:
                self.assertNotIn(forbidden, module)
            self.assertIn('tokio::task::yield_now().await', module)
            self.assertIn('pattern.score(', module)
            self.assertIn('pattern.indices(', module)
            self.assertEqual(overlay.apply_overlay(root, 'wasm32-wasip1'), [])

    def test_unanchored_walker_change_fails_before_any_write(self):
        with fixture() as (root, _, path):
            path.write_text(path.read_text().replace('.hidden(false)', '.hidden(true)'))
            before = {p.relative_to(root): p.read_bytes() for p in root.rglob('*') if p.is_file()}
            with self.assertRaisesRegex(overlay.OverlayError, 'expected source sha256.*#1072'):
                overlay.apply_overlay(root, 'wasm32-wasip1')
            self.assertEqual({p.relative_to(root): p.read_bytes() for p in root.rglob('*') if p.is_file()}, before)
            self.assertFalse((path.parent / 'wasi.rs').exists())

    def test_mutated_applied_source_is_not_accepted_as_idempotent(self):
        with fixture() as (root, _, path):
            overlay.apply_overlay(root, 'wasm32-wasip1')
            path.write_text(path.read_text().replace('.hidden(false)', '.hidden(true)'))
            with self.assertRaisesRegex(overlay.OverlayError, 'expected source sha256.*#1072'):
                overlay.apply_overlay(root, 'wasm32-wasip1')

    def test_changed_worker_shape_fails_before_any_write(self):
        with fixture() as (root, _, path):
            original = path.read_text().replace('thread::spawn(move || matcher_worker', 'thread::spawn(move || changed_worker')
            path.write_text(original)
            with self.assertRaisesRegex(overlay.OverlayError, 'expected source sha256.*#1072'):
                overlay.apply_overlay(root, 'wasm32-wasip1')
            self.assertEqual(path.read_text(), original)
            self.assertFalse((path.parent / 'wasi.rs').exists())

if __name__ == '__main__':
    unittest.main()
