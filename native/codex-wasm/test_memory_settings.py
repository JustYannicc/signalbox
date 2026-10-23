"""Package-default pins must retain all later configuration authority."""

import json
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest.mock import patch

from memory_settings import pin_memory_settings


class MemorySettingPinsTests(unittest.TestCase):
    def test_adds_only_verified_defaults_without_touching_user_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            defaults = source / "codex-rs/config/defaults.toml"
            defaults.parent.mkdir(parents=True)
            defaults.write_text(
                'project_doc_max_bytes = 32768\n[history]\npersistence = "save-all"\n'
            )
            user_config = source / "home/config.toml"
            user_config.parent.mkdir()
            user_config.write_text("[memories]\nmax_rollouts_per_startup = 7\n")
            evidence = {
                "provider": "codex",
                "pins": {"memories.max_rollouts_per_startup": 2},
                "evidence": [
                    {"key": "memories.max_rollouts_per_startup", "default": 2}
                ],
            }
            with patch(
                "memory_settings.subprocess.run",
                return_value=subprocess.CompletedProcess(
                    [],
                    0,
                    json.dumps(evidence),
                ),
            ):
                self.assertEqual(pin_memory_settings(source), evidence)
            self.assertEqual(
                tomllib.loads(defaults.read_text()),
                {
                    "project_doc_max_bytes": 32768,
                    "history": {"persistence": "save-all"},
                    "memories": {"max_rollouts_per_startup": 2},
                },
            )
            self.assertEqual(
                tomllib.loads(user_config.read_text()),
                {
                    "memories": {"max_rollouts_per_startup": 7},
                },
            )

    def test_guard_failure_leaves_package_defaults_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            defaults = source / "codex-rs/config/defaults.toml"
            defaults.parent.mkdir(parents=True)
            original = "project_doc_max_bytes = 32768\n"
            defaults.write_text(original)
            with (
                patch(
                    "memory_settings.subprocess.run",
                    side_effect=subprocess.CalledProcessError(
                        1,
                        "checkMemorySettings.ts",
                    ),
                ),
                self.assertRaises(subprocess.CalledProcessError),
            ):
                pin_memory_settings(source)
            self.assertEqual(defaults.read_text(), original)


if __name__ == "__main__":
    unittest.main()
