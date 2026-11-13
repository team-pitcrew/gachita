"""docs/tasks.md가 읽히는지와, 이슈로 맞추는 계획이 맞는지 본다. 네트워크를 쓰지 않는다."""
import json
import re
import unittest
from pathlib import Path

import tasks

ROOT = Path(__file__).resolve().parents[2]
CONFIG = json.loads((ROOT / ".github/parts.json").read_text())
PARTS = CONFIG["parts"]
ONE = "### T1 가 (P0) · backend-api\n\n- [ ] 일\n\n완료 기준: 끝\n"
FORM = "### 파트\n\nx\n\n### 필요한 환경\n\n없음\n"  # 새 양식으로 만든 본문


class TasksTest(unittest.TestCase):
    def test_plan_file_parses_and_every_task_has_a_part(self):
        parsed = tasks.parse((ROOT / "docs/tasks.md").read_text(), PARTS)
        self.assertGreater(len(parsed), 20)
        self.assertTrue(all(t["part"] in PARTS for t in parsed))

    def test_role_list_matches_tasks(self):
        """'역할 분담'에 적은 T번호가 실제 작업에서 '끝난 작업'을 뺀 것과 같아야 한다."""
        text = (ROOT / "docs/tasks.md").read_text()
        listed = set(re.findall(r"^- `(T\d+)`", text, flags=re.M))
        closed = set(re.findall(r"T\d+", re.search(r"^끝난 작업: (.+)$", text, flags=re.M)[1]))
        self.assertEqual(listed, {t["id"] for t in tasks.parse(text, PARTS)} - closed)

    def test_form_offers_the_environments_this_script_writes(self):
        form = (ROOT / ".github/ISSUE_TEMPLATE/ticket.yml").read_text()
        for option in (tasks.ENV_NONE, tasks.ENV_EMULATOR):
            self.assertIn(f"        - {option}\n", form)

    def test_optional_lines(self):
        text = ONE.replace("- [ ] 일", "왜: 이유\n\n환경: 에뮬레이터\n\n- [ ] 일\n\n하지 않는 것: 저것\n\n위험: 없음")
        (task,) = tasks.parse(text, PARTS)
        self.assertEqual((task["why"], task["env"], task["skip"], task["risk"]), ("이유", "에뮬레이터", "저것", "없음"))
        made = tasks.body(task, PARTS)
        for part in ("### 필요한 환경\n\n" + tasks.ENV_EMULATOR, "### 왜 하는가\n\n이유", "### 하지 않는 것\n\n저것", "### 위험과 되돌리기\n\n없음"):
            self.assertIn(part, made)
        with self.assertRaises(AssertionError):
            tasks.parse(ONE.replace("- [ ] 일", "환경: 실차\n\n- [ ] 일"), PARTS)

    def test_design_lines_go_to_their_form_fields(self):
        text = ONE.replace("완료 기준: 끝", "서비스 수준: 이름 정확도 60% 이상\n\n의존성: 모델 파일\n\n완료 기준: 끝")
        made = tasks.body(tasks.parse(text, PARTS)[0], PARTS)
        self.assertIn("### 서비스 수준\n\n이름 정확도 60% 이상", made)
        self.assertIn("### 의존성과 장애 동작\n\n모델 파일", made)
        self.assertIn("### 관측\n\n_No response_", made)

    def test_body_has_the_form_fields_in_order(self):
        """양식으로 만든 티켓과 작업 목록으로 만든 티켓이 같은 칸을 같은 순서로 가진다."""
        form = (ROOT / ".github/ISSUE_TEMPLATE/ticket.yml").read_text()
        labels = re.findall(r"^      label: (.+)$", form, flags=re.M)
        made = re.findall(r"^### (.+)$", tasks.body(tasks.parse(ONE, PARTS)[0], PARTS), flags=re.M)
        self.assertEqual(made, labels)

    def test_plan_creates_labels_and_assigns(self):
        text = ONE + "\n### T2 나 (P1) · frontend-app · 선행 T1\n\n- [ ] 일\n\n완료 기준: 끝\n"
        parsed = tasks.parse(text, PARTS)
        issues = [{"number": 9, "title": "[T2] 나", "state": "OPEN", "labels": [{"name": "part:backend-api"}], "assignees": [], "body": FORM}]
        plan = tasks.plan(parsed, issues, CONFIG)
        self.assertEqual([k for k, _ in plan], ["create", "label", "assign"])
        create, label, assign = (a for _, a in plan)
        self.assertEqual(create["title"], "[T1] 가")
        self.assertIn("### 파트\n\n" + PARTS["backend-api"]["name"], create["body"])
        self.assertEqual(create["assignee"], PARTS["backend-api"]["owner"])
        self.assertEqual((label["add"], label["remove"]), (["part:frontend-app"], ["part:backend-api"]))
        self.assertEqual(assign["assignee"], PARTS["frontend-app"]["owner"])

    def test_same_number_with_another_title_is_left_alone(self):
        """양식으로 만든 티켓이 작업 목록의 번호를 먼저 받았으면 본문·라벨을 덮어쓰지 않는다(#70 사고)."""
        parsed = tasks.parse(ONE, PARTS)
        other = {"number": 70, "title": "[T1] CI 범위를 나눈다", "state": "OPEN", "labels": [{"name": "part:backend-infra"}], "assignees": [], "body": "- [ ] 다른 일"}
        self.assertEqual(tasks.plan(parsed, [other], CONFIG, refresh=True),
                         [("conflict", {"number": 70, "title": "[T1] CI 범위를 나눈다", "want": "[T1] 가"})])

    def test_emulator_task_goes_to_the_emulator_owner(self):
        parsed = tasks.parse(ONE.replace("- [ ] 일", "환경: 에뮬레이터\n\n- [ ] 일"), PARTS)
        ((kind, create),) = tasks.plan(parsed, [], CONFIG)
        self.assertEqual((kind, create["assignee"]), ("create", CONFIG["emulator_owner"]))
        self.assertIn("env:emulator", create["labels"])
        issue = {"number": 1, "title": "[T1] 가", "state": "OPEN", "labels": [{"name": "part:backend-api"}], "assignees": [{"login": "x"}], "body": FORM}
        self.assertEqual(tasks.plan(parsed, [issue], CONFIG), [("label", {"number": 1, "add": ["env:emulator"], "remove": []})], "이미 있는 담당은 바꾸지 않는다")

    def test_closed_or_assigned_issues_keep_their_assignee(self):
        parsed = tasks.parse(ONE, PARTS)
        for issue in ({"state": "CLOSED", "assignees": [], "body": "옛 본문"}, {"state": "OPEN", "assignees": [{"login": "x"}], "body": FORM}):
            issue |= {"number": 1, "title": "[T1] 가", "labels": [{"name": "part:backend-api"}]}
            self.assertEqual(tasks.plan(parsed, [issue], CONFIG), [])

    def test_only_untouched_old_bodies_are_rewritten(self):
        parsed = tasks.parse(ONE, PARTS)
        issue = {"number": 1, "title": "[T1] 가", "state": "OPEN", "labels": [{"name": "part:backend-api"}], "assignees": [{"login": "x"}]}
        ((kind, action),) = tasks.plan(parsed, [issue | {"body": "- [ ] 일\n\n완료 기준: 끝"}], CONFIG)
        self.assertEqual((kind, action["number"]), ("body", 1))
        self.assertIn("### 필요한 환경\n\n" + tasks.ENV_NONE, action["body"])
        self.assertEqual(tasks.plan(parsed, [issue | {"body": "- [x] 일\n\n완료 기준: 끝"}], CONFIG), [], "체크한 것이 있으면 그대로 둔다")
        self.assertEqual(tasks.plan(parsed, [issue | {"body": FORM}], CONFIG), [], "새 양식이면 그대로 둔다")

    def test_refresh_rewrites_changed_bodies_but_keeps_checked_ones(self):
        parsed = tasks.parse(ONE, PARTS)
        same = tasks.body(parsed[0], PARTS)
        issue = {"number": 1, "title": "[T1] 가", "state": "OPEN", "labels": [{"name": "part:backend-api"}], "assignees": [{"login": "x"}]}
        self.assertEqual(tasks.plan(parsed, [issue | {"body": same}], CONFIG, refresh=True), [], "같으면 쓰지 않는다")
        ((kind, action),) = tasks.plan(parsed, [issue | {"body": same.replace("끝", "옛 기준")}], CONFIG, refresh=True)
        self.assertEqual((kind, action["body"]), ("body", same))
        self.assertEqual(tasks.plan(parsed, [issue | {"body": same.replace("- [ ] 일", "- [x] 일").replace("끝", "옛 기준")}], CONFIG, refresh=True), [], "체크한 것이 있으면 그대로 둔다")
        self.assertEqual(tasks.plan(parsed, [issue | {"body": same.replace("끝", "옛 기준"), "state": "CLOSED"}], CONFIG, refresh=True), [], "닫힌 이슈는 그대로 둔다")


if __name__ == "__main__":
    unittest.main()
