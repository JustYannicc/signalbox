"""Keep the WASI rollout clock adaptation narrow and fail on source drift."""

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import overlay


class RolloutClockTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.rule = next(rule for rule in overlay._rules() if rule['rule'] == 'rollout-clock')
        self.path = self.root / self.rule['path']
        self.path.parent.mkdir(parents=True)
        self.source = ('fn precompute_new_rollout_path() {\n'
                       + overlay._text(self.rule, 'before')
                       + '    let mut dir = config.codex_home().to_path_buf();\n}\n')
        self.path.write_text(self.source)
        mocked = patch.object(overlay, '_rules', return_value=[self.rule])
        mocked.start()
        self.addCleanup(mocked.stop)

    def test_preserves_native_error_handling_and_surrounding_path_logic(self):
        changes = overlay.apply_overlay(self.root, 'wasm32-wasip1')
        self.assertEqual(changes, [{'path': self.rule['path'], 'rule': 'rollout-clock'}])
        result = self.path.read_text()
        self.assertIn('#[cfg(target_os = "wasi")]', result)
        self.assertIn('OffsetDateTime::now_utc()', result)
        self.assertIn('#[cfg(not(target_os = "wasi"))]', result)
        self.assertIn(overlay._text(self.rule, 'before').strip(), result)
        self.assertTrue(result.endswith('    let mut dir = config.codex_home().to_path_buf();\n}\n'))
        self.assertEqual(overlay.apply_overlay(self.root, 'wasm32-wasip1'), [])

    def test_changed_local_time_error_fails_without_writes(self):
        original = self.source.replace('failed to get local time', 'different operation')
        self.path.write_text(original)
        with self.assertRaisesRegex(overlay.OverlayError, 'rollout-clock.*#1072'):
            overlay.apply_overlay(self.root, 'wasm32-wasip1')
        self.assertEqual(self.path.read_text(), original)

    def test_unsupported_target_leaves_original_clock_unchanged(self):
        with self.assertRaisesRegex(overlay.OverlayError, 'unsupported overlay target'):
            overlay.apply_overlay(self.root, 'wasm32-unknown-emscripten')
        self.assertEqual(self.path.read_text(), self.source)


if __name__ == '__main__':
    unittest.main()
