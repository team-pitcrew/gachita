#!/usr/bin/env python3
"""docs/tasks.md의 작업을 GitHub 이슈(티켓)로 맞춘다.

    python3 .github/scripts/tasks.py            # 무엇을 할지만 보여 준다
    python3 .github/scripts/tasks.py --apply    # 없는 이슈를 만들고, 파트 라벨과 담당을 맞춘다

- 없는 T번호는 이슈 양식(.github/ISSUE_TEMPLATE/ticket.yml)과 같은 본문으로 만든다.
- 이미 있는 이슈는 파트 라벨과 환경 라벨을 맞추고, 열린 이슈에 담당이 없으면 담당을 넣는다.
- 본문은 옛 양식(칸이 모자란 것)이고 체크한 항목이 없는 열린 이슈만 새 양식으로 다시 쓴다. 그 밖의 본문과 체크는 건드리지 않는다.
- 파트와 담당의 원본은 .github/parts.json이다. 에뮬레이터가 필요한 작업은 파트와 관계없이 emulator_owner가 맡는다.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

REPO = "team-pitcrew/gachita"
ROOT = Path(__file__).resolve().parents[2]
HEAD = re.compile(r"^### (T\d+) (.+?) \((P[012])\) · ([a-z-]+)(?: · 선행 (.+))?$")
EXTRA = {"왜": "why", "환경": "env", "하지 않는 것": "skip", "위험": "risk"}  # 작업마다 적어도 되는 줄
ENV_NONE, ENV_EMULATOR = "없음 · 로컬과 문서로 끝남", "에뮬레이터 · Pleos 에뮬레이터에서 확인"  # 이슈 양식의 선택지와 같아야 한다


def parse(text, parts):
    tasks, cur = [], None
    for line in text.splitlines():
        m = HEAD.match(line)
        if m:
            assert m[4] in parts, f"{m[1]}: 모르는 파트 {m[4]}"
            cur = {"id": m[1], "title": m[2], "priority": m[3], "part": m[4], "after": m[5] or "", "todo": [], "done": "",
                   "why": "", "env": "", "skip": "", "risk": ""}
            tasks.append(cur)
        elif line.startswith("### "):
            raise AssertionError(f"제목 줄 형식이 다름: {line}")
        elif line.startswith("## "):
            cur = None
        elif cur and line.startswith("- [ ] "):
            cur["todo"].append(line)
        elif cur and line.startswith("완료 기준:"):
            cur["done"] = line.removeprefix("완료 기준:").strip()
        elif cur and (hit := next((k for k in EXTRA if line.startswith(k + ":")), None)):
            cur[EXTRA[hit]] = line.removeprefix(hit + ":").strip()
    assert tasks and all(t["todo"] and t["done"] for t in tasks), "할 일이나 완료 기준이 빈 작업이 있음"
    assert len({t["id"] for t in tasks}) == len(tasks), "T번호가 겹침"
    assert all(t["env"] in ("", "에뮬레이터") for t in tasks), "환경은 비우거나 '에뮬레이터'"
    return tasks


def emulator(task):
    return task["env"] == "에뮬레이터"


def owner(task, config):
    return config["emulator_owner"] if emulator(task) else config["parts"][task["part"]]["owner"]


def body(task, parts):
    """이슈 양식이 만드는 본문과 같은 제목을 쓴다. 티켓 자동화가 같은 방식으로 읽는다."""
    sections = [
        ("파트", parts[task["part"]]["name"]),
        ("우선순위", task["priority"]),
        ("필요한 환경", ENV_EMULATOR if emulator(task) else ENV_NONE),
        ("왜 하는가", task["why"] or "계획 원문: docs/tasks.md"),
        ("할 일", "\n".join(task["todo"])),
        ("하지 않는 것", task["skip"] or "_No response_"),
        ("완료 기준", task["done"]),
        ("위험과 되돌리기", task["risk"] or "_No response_"),
        ("선행 작업", task["after"] or "_No response_"),
    ]
    return "\n\n".join(f"### {name}\n\n{value}" for name, value in sections)


def plan(tasks, issues, config):
    """할 일을 (동작, 인자) 목록으로 돌려준다. 네트워크를 쓰지 않아 테스트할 수 있다."""
    parts = config["parts"]
    have = {m[1]: i for i in issues if (m := re.match(r"^\[(T\d+)\] ", i["title"]))}
    actions = []
    for t in tasks:
        want = [f"part:{t['part']}"] + (["env:emulator"] if emulator(t) else [])
        issue = have.get(t["id"])
        if not issue:
            actions.append(("create", {"title": f"[{t['id']}] {t['title']}", "body": body(t, parts),
                                       "labels": ["type:task", *want, t["priority"], "status:backlog"], "assignee": owner(t, config)}))
            continue
        names = {l["name"] for l in issue["labels"]}
        add = [l for l in want if l not in names]
        stale = sorted(n for n in names if n.startswith("part:") and n != want[0])
        if add or stale:
            actions.append(("label", {"number": issue["number"], "add": add, "remove": stale}))
        if issue["state"] != "OPEN":
            continue
        if not issue["assignees"]:
            actions.append(("assign", {"number": issue["number"], "assignee": owner(t, config)}))
        old = issue.get("body") or ""
        if "### 필요한 환경" not in old and "- [x]" not in old.lower():
            actions.append(("body", {"number": issue["number"], "body": body(t, parts)}))
    return actions


def gh(*args):
    return subprocess.run(["gh", *args, "-R", REPO], capture_output=True, text=True, check=True).stdout


def main():
    config = json.loads((ROOT / ".github/parts.json").read_text())
    tasks = parse((ROOT / "docs/tasks.md").read_text(), config["parts"])
    issues = json.loads(gh("issue", "list", "--state", "all", "--limit", "300", "--json", "number,title,state,labels,assignees,body"))
    apply = "--apply" in sys.argv
    for kind, a in plan(tasks, issues, config):
        if kind == "create":
            print(("만듦: " if apply else "만들 예정: ") + f"{a['title']} → {a['assignee']}")
            if apply:
                gh("issue", "create", "--title", a["title"], "--body", a["body"], "--assignee", a["assignee"],
                   *[x for label in a["labels"] for x in ("--label", label)])
        elif kind == "label":
            print(("라벨: " if apply else "라벨 예정: ") + f"#{a['number']} +{a['add']} -{a['remove']}")
            if apply:
                gh("issue", "edit", str(a["number"]), *[x for label in a["add"] for x in ("--add-label", label)],
                   *[x for label in a["remove"] for x in ("--remove-label", label)])
        elif kind == "body":
            print(("본문: " if apply else "본문 예정: ") + f"#{a['number']} 새 양식으로")
            if apply:
                gh("issue", "edit", str(a["number"]), "--body", a["body"])
        elif kind == "assign":
            print(("담당: " if apply else "담당 예정: ") + f"#{a['number']} → {a['assignee']}")
            if apply:
                gh("issue", "edit", str(a["number"]), "--add-assignee", a["assignee"])


if __name__ == "__main__":
    main()
