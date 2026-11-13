"""tickets.py의 순수 함수 검사. 네트워크 없이 돈다.

    python3 -m unittest discover -s .github/scripts -p 'test_tickets.py'
"""
import re
import unittest
from pathlib import Path

import tickets as t

FORM = """### 파트

{part}

### 우선순위

P1 · 제출 점수에 도움

### 왜 하는가

차량 화면이 없어서

### 할 일

- [ ] 틀 만들기

### 완료 기준

에뮬레이터에서 뜬다

### 선행 작업

_No response_
"""


class Reading(unittest.TestCase):
    def test_part_by_name_and_by_key(self):
        for key, part in t.PARTS.items():
            self.assertEqual(t.part_of(FORM.format(part=part["name"])), key)
            self.assertEqual(t.part_of(FORM.format(part=key)), key)
        self.assertIsNone(t.part_of(FORM.format(part="없는 파트")))
        self.assertIsNone(t.part_of("양식 없이 쓴 본문"))
        self.assertIsNone(t.part_of(None))

    def test_priority(self):
        self.assertEqual(t.priority_of(FORM.format(part="backend-api")), "P1")
        self.assertIsNone(t.priority_of("### 우선순위\n\n_No response_"))

    def test_bug_severity_sets_priority(self):
        for severity, priority in (("S0 · 시연이 막힘", "P0"), ("S1 · 핵심 흐름", "P0"), ("S2 · 일부", "P1"), ("S3 · 불편", "P2")):
            self.assertEqual(t.priority_of(f"### 심각도\n\n{severity}"), priority)

    def test_emulator_tickets_go_to_the_emulator_owner(self):
        body = FORM.format(part="backend-api")
        self.assertFalse(t.needs_emulator(body))
        self.assertEqual(t.owner_of(body), t.PARTS["backend-api"]["owner"])
        for heading, value in (("필요한 환경", "에뮬레이터 · Pleos 에뮬레이터에서 확인"), ("확인한 환경", "에뮬레이터에서 확인")):
            emulator = body + f"\n### {heading}\n\n{value}\n"
            self.assertTrue(t.needs_emulator(emulator), heading)
            self.assertEqual(t.owner_of(emulator), t.CONFIG["emulator_owner"], heading)
        self.assertFalse(t.needs_emulator(body + "\n### 필요한 환경\n\n없음 · 로컬과 문서로 끝남\n"))
        self.assertIsNone(t.owner_of("### 필요한 환경\n\n에뮬레이터"), "파트를 모르면 담당도 정하지 않는다")

    def test_forms_offer_exactly_the_parts(self):
        # 양식의 선택지는 parts.json의 이름과 같아야 한다(양식은 YAML이라 따로 적을 수밖에 없다)
        names = [p["name"] for p in t.PARTS.values()]
        for form in ("ticket.yml", "bug.yml"):
            text = Path(t.__file__).resolve().parents[1].joinpath("ISSUE_TEMPLATE", form).read_text()
            block = text[text.index("label: 파트"):]
            options = re.findall(r"^        - (.+)$", block[:block.index("validations:")], re.M)
            self.assertEqual(options, names, form)


class Numbering(unittest.TestCase):
    def test_next_number(self):
        self.assertEqual(t.next_number(["[T1] 가", "[T15] 나", "번호 없음", "[T] 자리 표시", "[사후 검토] 다"]), 16)
        self.assertEqual(t.next_number([]), 1)

    def test_planned_numbers_from_task_list(self):
        text = "## 계획\n\n### T3 가 (P1) · backend-api\n\n본문의 ### T9는 제목이 아님\n### T12 나 (P0) · frontend-app · 선행 T3\n"
        self.assertEqual(t.planned_numbers(text), [3, 12])
        self.assertEqual(t.planned_numbers(""), [])

    def test_numbered_title(self):
        self.assertEqual(t.numbered_title("[T] 차량 앱 틀", 16), "[T16] 차량 앱 틀")
        self.assertEqual(t.numbered_title("[T]차량 앱 틀", 16), "[T16] 차량 앱 틀")
        self.assertEqual(t.numbered_title("차량 앱 틀", 16), "[T16] 차량 앱 틀")
        self.assertEqual(t.numbered_title("[T7] 이미 있음", 16), "[T7] 이미 있음")

    def test_only_form_tickets_get_a_number(self):
        body = FORM.format(part="backend-infra")
        self.assertTrue(t.needs_number("[T] 새 티켓", body))
        self.assertTrue(t.needs_number("자리 표시를 지운 제목", body))
        self.assertTrue(t.needs_number("[T] 본문을 지운 티켓", ""))
        self.assertFalse(t.needs_number("[T7] 이미 있음", body))
        self.assertFalse(t.needs_number("[사후 검토] 배포 실패", "### 요약\n\n내용"))


class PullRequests(unittest.TestCase):
    def test_tickets_from_title_branch_and_body(self):
        info = t.pr_tickets("[T7] 차량 앱 틀", "feature/T7-car-shell", "설명\n\nRefs #8\nCloses #9, fixes #10")
        self.assertEqual(info, {"t": {7}, "refs": {8}, "closes": {9, 10}})
        self.assertEqual(t.pr_tickets("[setup] 훅", "hotfix/T3-fix", "Refs #")["t"], {3})
        self.assertEqual(t.pr_tickets("[T2] 가", "feature/T2-x", "Refs #3\nCloses #3"), {"t": {2}, "refs": set(), "closes": {3}})
        self.assertEqual(t.pr_tickets(None, None, None), {"t": set(), "refs": set(), "closes": set()})

    def test_branch(self):
        self.assertEqual(t.branch_ticket("feature/T12-voice"), 12)
        self.assertEqual(t.branch_ticket("refs/heads/hotfix/T4-x"), 4)
        for ref in ("develop", "release/v0.1.0", "feature/voice", "bot/sync-tasks", None):
            self.assertIsNone(t.branch_ticket(ref))

    def test_state_after_pr_event(self):
        for action in ("opened", "reopened", "ready_for_review"):
            self.assertEqual(t.pr_state(action, False, False), "in-review")
        self.assertEqual(t.pr_state("closed", True, True), "done")
        self.assertEqual(t.pr_state("closed", True, False), "in-progress", "Refs로만 연결된 티켓은 끝나지 않았다")
        self.assertEqual(t.pr_state("closed", False, True), "in-progress", "병합 없이 닫히면 다시 작업 중")

    def test_changed_files_to_parts(self):
        self.assertEqual(t.file_parts(["backend/api/server.js", "docs/api/openapi.yaml"]), ["backend-api"])
        self.assertEqual(t.file_parts(["frontend/web/app.js", "backend/infra/terraform/iam.tf"]), ["backend-infra", "frontend-app"])
        self.assertEqual(t.file_parts(["frontend/spec/join.md"]), ["frontend-spec"])
        self.assertEqual(t.file_parts(["README.md", "docs/tasks.md", ""]), [])


class Labels(unittest.TestCase):
    def test_new_ticket(self):
        add, remove = t.label_plan(["type:task"], part="backend-api", priority="P0", state="backlog")
        self.assertEqual((add, remove), (["P0", "part:backend-api", "status:backlog"], []))

    def test_one_of_each_kind(self):
        labels = ["type:task", "part:frontend-app", "P2", "status:backlog", "status:ready"]
        add, remove = t.label_plan(labels, part="backend-infra", priority="P0", state="in-review")
        self.assertEqual(add, ["P0", "part:backend-infra", "status:in-review"])
        self.assertEqual(remove, ["P2", "part:frontend-app", "status:backlog", "status:ready"])

    def test_nothing_to_do(self):
        labels = ["part:backend-api", "P1", "status:in-progress"]
        self.assertEqual(t.label_plan(labels, part="backend-api", priority="P1", state="in-progress"), ([], []))
        self.assertEqual(t.label_plan(labels), ([], []), "읽지 못한 항목은 건드리지 않는다")

    def test_removing_a_label_that_is_already_gone_is_not_an_error(self):
        # 브랜치와 PR 이벤트가 겹쳐 다른 실행이 먼저 뗀 경우(HTTP 404). 다른 오류는 그대로 올린다.
        calls, real = [], t.gh

        def fake(*args, **kw):
            calls.append(args)
            if args[2] == "DELETE":
                raise RuntimeError("gh api -X DELETE 실패: gh: Label does not exist (HTTP 404)")
            return ""

        t.gh = fake
        try:
            t.set_labels(7, ["status:in-progress"], ["status:backlog"])
            self.assertEqual([c[2] for c in calls], ["DELETE", "POST"])
            t.gh = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("gh api -X DELETE 실패: HTTP 403"))
            with self.assertRaises(RuntimeError):
                t.set_labels(7, [], ["status:backlog"])
        finally:
            t.gh = real

    def test_status_of(self):
        self.assertEqual(t.status_of(["P0", "status:in-review"]), "in-review")
        self.assertIsNone(t.status_of(["P0"]))


class Project(unittest.TestCase):
    def test_every_state_has_a_column(self):
        self.assertEqual(list(t.PROJECT_STATUS.values()), ["Backlog", "Ready", "In progress", "In review", "Done"])

    def test_status_option_ignores_case(self):
        options = [{"id": "a", "name": "Backlog"}, {"id": "b", "name": "In Progress"}, {"id": "c", "name": " done "}]
        self.assertEqual(t.status_option(options, "in-progress"), "b")
        self.assertEqual(t.status_option(options, "done"), "c")
        self.assertIsNone(t.status_option(options, "in-review"))

    def test_graphql_args(self):
        args = t.graphql_args("query { x }", {"org": "team-pitcrew", "number": 3})
        self.assertEqual(args, ["api", "graphql", "-f", "query=query { x }", "-f", "org=team-pitcrew", "-F", "number=3"])

    def test_skips_without_token(self):
        # 토큰이나 번호가 없으면 gh를 부르지 않고 끝난다(부르면 테스트 환경에서 실패한다)
        import os
        for key in ("PROJECT_TOKEN", "PROJECT_NUMBER"):
            os.environ.pop(key, None)
        self.assertIsNone(t.sync_project("node", "done"))


if __name__ == "__main__":
    unittest.main()
