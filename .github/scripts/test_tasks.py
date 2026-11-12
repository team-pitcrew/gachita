"""docs/tasks.md가 읽히는지와, 이슈로 맞추는 계획이 맞는지 본다. 네트워크를 쓰지 않는다."""
import json
import unittest
from pathlib import Path

import tasks

ROOT = Path(__file__).resolve().parents[2]
PARTS = json.loads((ROOT / ".github/parts.json").read_text())["parts"]


class TasksTest(unittest.TestCase):
    def test_plan_file_parses_and_every_task_has_a_part(self):
        parsed = tasks.parse((ROOT / "docs/tasks.md").read_text(), PARTS)
        self.assertGreater(len(parsed), 20)
        self.assertTrue(all(t["part"] in PARTS for t in parsed))

    def test_role_list_matches_tasks(self):
        """'역할 분담'에 적은 T번호가 실제 작업과 같아야 한다."""
        text = (ROOT / "docs/tasks.md").read_text()
        listed = set(__import__("re").findall(r"^- `(T\d+)`", text, flags=8))
        closed = {"T1", "T2", "T3", "T4", "T5", "T15"}
        self.assertEqual(listed, {t["id"] for t in tasks.parse(text, PARTS)} - closed)

    def test_plan_creates_labels_and_assigns(self):
        text = "### T1 가 (P0) · backend-api\n\n- [ ] 일\n\n완료 기준: 끝\n\n### T2 나 (P1) · frontend-app · 선행 T1\n\n- [ ] 일\n\n완료 기준: 끝\n"
        parsed = tasks.parse(text, PARTS)
        issues = [{"number": 9, "title": "[T2] 나", "state": "OPEN", "labels": [{"name": "part:backend-api"}], "assignees": []}]
        plan = tasks.plan(parsed, issues, PARTS)
        self.assertEqual([k for k, _ in plan], ["create", "label", "assign"])
        create, label, assign = (a for _, a in plan)
        self.assertEqual(create["title"], "[T1] 가")
        self.assertIn("### 파트\n\n" + PARTS["backend-api"]["name"], create["body"])
        self.assertEqual(create["assignee"], PARTS["backend-api"]["owner"])
        self.assertEqual((label["add"], label["remove"]), ("part:frontend-app", ["part:backend-api"]))
        self.assertEqual(assign["assignee"], PARTS["frontend-app"]["owner"])

    def test_closed_or_assigned_issues_keep_their_assignee(self):
        parsed = tasks.parse("### T1 가 (P0) · backend-api\n\n- [ ] 일\n\n완료 기준: 끝\n", PARTS)
        for issue in ({"state": "CLOSED", "assignees": []}, {"state": "OPEN", "assignees": [{"login": "x"}]}):
            issue |= {"number": 1, "title": "[T1] 가", "labels": [{"name": "part:backend-api"}]}
            self.assertEqual(tasks.plan(parsed, [issue], PARTS), [])


if __name__ == "__main__":
    unittest.main()
