"""Classify pull-request merge commits in disposable repositories, without network access."""

import pathlib
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name("changed-areas.sh").resolve()
BASE_FILES = ("apps/web/src/logo.svg", "apps/mobile/app/index.tsx", "README.md")


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, stderr=subprocess.DEVNULL, text=True)


def areas(change):
    """Commit `change(root)` on a branch, merge it into the base, and classify the merge commit."""
    with tempfile.TemporaryDirectory() as directory:
        root = pathlib.Path(directory)
        git(root, "init", "-q", "-b", "main")
        git(root, "config", "user.name", "Test")
        git(root, "config", "user.email", "test@example.invalid")
        git(root, "config", "commit.gpgsign", "false")
        git(root, "config", "core.hooksPath", "/dev/null")
        for name in BASE_FILES:
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            (root / name).write_text(f"{name}\n")
        git(root, "add", "-A")
        git(root, "commit", "-qm", "base")
        git(root, "switch", "-qc", "pr")
        change(root)
        git(root, "add", "-A")
        git(root, "commit", "-qm", "change")
        git(root, "switch", "-q", "main")
        (root / "base-moved.txt").write_text("main moved on\n")
        git(root, "add", "-A")
        git(root, "commit", "-qm", "unrelated main commit")
        git(root, "merge", "-q", "--no-ff", "-m", "merge", "pr")
        output = subprocess.check_output(["bash", str(SCRIPT)], cwd=root, text=True)
        return dict(line.split("=", 1) for line in output.split())


def write(path, text="changed\n"):
    def change(root):
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_text(text)

    return change


class ChangedAreasTests(unittest.TestCase):
    def test_classifies_what_the_pull_request_changed(self):
        cases = [
            ("apps/mobile/app/screen.tsx", "false", "false"),
            (".agents/skills/x/SKILL.md", "false", "false"),
            ("CHANGELOG.md", "false", "false"),
            ("docs/getting-started.md", "true", "false"),
            ("apps/www/src/page.astro", "true", "false"),
            ("apps/mobile/package.json", "true", "true"),
            ("packages/core/README.md", "true", "true"),
            ("apps/web/src/app.ts", "true", "true"),
            (".github/workflows/ci.yml", "true", "true"),
        ]
        for path, web, server in cases:
            with self.subTest(path=path):
                self.assertEqual(areas(write(path)), {"web": web, "server": server})

    def test_a_rename_out_of_the_web_app_counts_its_old_path(self):
        def move(root):
            (root / "apps/mobile/assets").mkdir()
            git(root, "mv", "apps/web/src/logo.svg", "apps/mobile/assets/logo.svg")

        self.assertEqual(areas(move), {"web": "true", "server": "true"})


if __name__ == "__main__":
    unittest.main()
