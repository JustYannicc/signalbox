# pyright: reportImplicitRelativeImport=false, reportUninitializedInstanceVariable=false
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from sources import export_tree, git, read_pin, verify_checkout, verify_output_location


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "source"
        self.root.mkdir()
        subprocess.run(["git", "init", "--quiet", str(self.root)], check=True)
        (self.root / "file.rs").write_text("fn main() {}\n")
        subprocess.run(["git", "-C", str(self.root), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.root), "-c", "user.name=Test",
                        "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m",
                        "fixture"], check=True)
        self.commit = git(self.root, "rev-parse", "HEAD")

    def test_overlay_cannot_change_its_input(self):
        before = verify_checkout(self.root, self.commit)
        output = self.root.parent / "overlay"
        export_tree(self.root, output, self.commit)
        (output / "file.rs").write_text("fn changed() {}\n")
        self.assertEqual(verify_checkout(self.root, self.commit), before)
        self.assertEqual((self.root / "file.rs").read_text(), "fn main() {}\n")

    def test_changed_tracked_or_untracked_source_is_rejected(self):
        for name in ("file.rs", "untracked.rs"):
            with self.subTest(name=name):
                path = self.root / name
                old = path.read_bytes() if path.exists() else None
                path.write_text("changed\n")
                with self.assertRaisesRegex(ValueError, "not pristine"):
                    verify_checkout(self.root, self.commit)
                path.unlink() if old is None else path.write_bytes(old)

    def test_ignored_build_output_is_not_pristine(self):
        (self.root / ".gitignore").write_text("generated/\n")
        subprocess.run(["git", "-C", str(self.root), "add", ".gitignore"], check=True)
        subprocess.run(["git", "-C", str(self.root), "-c", "user.name=Test",
                        "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m",
                        "ignore generated files"], check=True)
        commit = git(self.root, "rev-parse", "HEAD")
        verify_checkout(self.root, commit)
        (self.root / "generated").mkdir()
        (self.root / "generated/output").write_text("build wrote inside its input")
        with self.assertRaisesRegex(ValueError, "not pristine"):
            verify_checkout(self.root, commit)

    def test_commit_mismatch_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "does not match"):
            verify_checkout(self.root, "0" * 40)

    def test_output_cannot_write_inside_any_source_or_its_alias(self):
        reference = self.root.parent / "reference"
        reference.mkdir()
        alias = self.root.parent / "source-alias"
        alias.symlink_to(self.root, target_is_directory=True)
        for source in [self.root, reference, alias]:
            output = source / "version/target"
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, "input checkout"):
                verify_output_location(output, [self.root, reference])
            self.assertFalse(output.exists())
        verify_output_location(self.root.parent / "output", [self.root, reference])

    def test_pin_requires_tag_commit_and_version_to_agree(self):
        path = self.root.parent / "pin.json"
        pin = {"version": "0.162.1", "tag": "rust-v0.162.1", "commit": self.commit,
               "repository": "https://github.com/openai/codex.git", "references": {}}
        path.write_text(json.dumps(pin))
        self.assertEqual(read_pin(path), pin)
        pin["tag"] = "rust-v0.162.2"
        path.write_text(json.dumps(pin))
        with self.assertRaisesRegex(ValueError, "disagree"):
            read_pin(path)


if __name__ == "__main__":
    unittest.main()
