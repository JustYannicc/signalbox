"""The WASI search session must never construct a background worker."""

from contextlib import contextmanager
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
        path = root / rules[0]['path']
        path.parent.mkdir(parents=True)
        source = '\n'.join(overlay._text(rule, 'before') for rule in rules if 'before' in rule)
        path.write_text(source)
        with patch.object(overlay, '_rules', return_value=rules):
            yield root, rules, path, source


class FileSearchTests(unittest.TestCase):
    def test_sync_session_and_native_workers_remain_separate(self):
        with fixture() as (root, rules, path, source):
            changes = overlay.apply_overlay(root, 'wasm32-wasip1')
            self.assertEqual(len(changes), len(rules))
            result = path.read_text()
            self.assertIn('wasi::search(&self.inner, pattern_text)', result)
            self.assertIn('#[cfg(not(target_os = "wasi"))]', result)
            self.assertIn('thread::spawn(move || matcher_worker', result)
            module = (path.parent / 'wasi.rs').read_text()
            for forbidden in ['Nucleo::new', 'thread::spawn', 'build_parallel', 'ThreadPool']:
                self.assertNotIn(forbidden, module)
            self.assertIn('builder.build()', module)
            self.assertIn('pattern.score(', module)
            self.assertIn('pattern.indices(', module)
            self.assertEqual(overlay.apply_overlay(root, 'wasm32-wasip1'), [])

    def test_changed_worker_shape_fails_before_any_write(self):
        with fixture() as (root, rules, path, source):
            original = source.replace('thread::spawn(move || matcher_worker', 'thread::spawn(move || changed_worker')
            path.write_text(original)
            with self.assertRaisesRegex(overlay.OverlayError, 'file-search-wasi-session.*#1072'):
                overlay.apply_overlay(root, 'wasm32-wasip1')
            self.assertEqual(path.read_text(), original)
            self.assertFalse((path.parent / 'wasi.rs').exists())


if __name__ == '__main__':
    unittest.main()
