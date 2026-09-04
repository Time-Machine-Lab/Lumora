import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("validate_pr.py")
SPEC = importlib.util.spec_from_file_location("validate_pr", MODULE_PATH)
VALIDATE_PR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATE_PR)

POLICY = {
    "default_branch": "main",
    "branch_pattern": r"^(ai|feat|fix|refactor|chore)/.+$",
    "required_pr_metadata": ["task_id", "run_id"],
    "task_id_pattern": r"^[A-Z][A-Z0-9]*-[0-9]+$",
    "require_task_id_in_pr_title": True,
}


class ValidatePullRequestTest(unittest.TestCase):
    def test_accepts_valid_pull_request(self):
        event = {
            "pull_request": {
                "title": "feat(example): MT-1 add example",
                "body": "<!-- multica\ntask_id: MT-1\nrun_id: RUN-1\n-->",
                "head": {"ref": "feat/example"},
                "base": {"ref": "main"},
            }
        }
        self.assertEqual([], VALIDATE_PR.validate(event, POLICY))

    def test_rejects_missing_metadata_and_invalid_branch(self):
        event = {
            "pull_request": {
                "body": "",
                "head": {"ref": "random"},
                "base": {"ref": "main"},
            }
        }
        failures = VALIDATE_PR.validate(event, POLICY)
        self.assertIn("branch name does not match policy: random", failures)
        self.assertIn("missing PR metadata: task_id", failures)
        self.assertIn("missing PR metadata: run_id", failures)

    def test_rejects_title_without_task_id(self):
        event = {
            "pull_request": {
                "title": "feat(home): add team homepage",
                "body": "<!-- multica\ntask_id: TML-741\nrun_id: RUN-1\n-->",
                "head": {"ref": "feat/home"},
                "base": {"ref": "main"},
            }
        }
        failures = VALIDATE_PR.validate(event, POLICY)
        self.assertIn("PR title must contain task_id: TML-741", failures)

    def test_rejects_title_with_different_task_id(self):
        event = {
            "pull_request": {
                "title": "feat(home): TML-742 add team homepage",
                "body": "<!-- multica\ntask_id: TML-741\nrun_id: RUN-1\n-->",
                "head": {"ref": "feat/home"},
                "base": {"ref": "main"},
            }
        }
        failures = VALIDATE_PR.validate(event, POLICY)
        self.assertIn("PR title must contain task_id: TML-741", failures)

    def test_rejects_task_id_prefix_match(self):
        event = {
            "pull_request": {
                "title": "feat(home): TML-7410 add team homepage",
                "body": "<!-- multica\ntask_id: TML-741\nrun_id: RUN-1\n-->",
                "head": {"ref": "feat/home"},
                "base": {"ref": "main"},
            }
        }
        failures = VALIDATE_PR.validate(event, POLICY)
        self.assertIn("PR title must contain task_id: TML-741", failures)


if __name__ == "__main__":
    unittest.main()
