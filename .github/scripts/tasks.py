#!/usr/bin/env python3
"""docs/tasks.md의 작업을 GitHub 이슈(티켓)로 맞춘다.

    python3 .github/scripts/tasks.py            # 무엇을 할지만 보여 준다
    python3 .github/scripts/tasks.py --apply    # 없는 이슈를 만들고, 파트 라벨과 담당을 맞춘다

- 없는 T번호는 이슈 양식(.github/ISSUE_TEMPLATE/ticket.yml)과 같은 본문으로 만든다.
- 이미 있는 이슈는 본문과 체크를 건드리지 않는다. 파트 라벨을 맞추고, 열린 이슈에 담당이 없으면 파트 담당을 넣는다.
- 파트와 담당의 원본은 .github/parts.json이다.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

REPO = "team-pitcrew/gachita"
ROOT = Path(__file__).resolve().parents[2]
HEAD = re.compile(r"^### (T\d+) (.+?) \((P[012])\) · ([a-z-]+)(?: · 선행 (.+))?$")


def parse(text, parts):
    tasks, cur = [], None
    for line in text.splitlines():
        m = HEAD.match(line)
        if m:
            assert m[4] in parts, f"{m[1]}: 모르는 파트 {m[4]}"
            cur = {"id": m[1], "title": m[2], "priority": m[3], "part": m[4], "after": m[5] or "", "todo": [], "done": ""}
            tasks.append(cur)
        elif line.startswith("### "):
            raise AssertionError(f"제목 줄 형식이 다름: {line}")
        elif line.startswith("## "):
            cur = None
        elif cur and line.startswith("- [ ] "):
            cur["todo"].append(line)
        elif cur and line.startswith("완료 기준:"):
            cur["done"] = line.removeprefix("완료 기준:").strip()
    assert tasks and all(t["todo"] and t["done"] for t in tasks), "할 일이나 완료 기준이 빈 작업이 있음"
    assert len({t["id"] for t in tasks}) == len(tasks), "T번호가 겹침"
    return tasks


def body(task, parts):
    """이슈 양식이 만드는 본문과 같은 제목을 쓴다. 티켓 자동화가 같은 방식으로 읽는다."""
    sections = [
        ("파트", parts[task["part"]]["name"]),
        ("우선순위", task["priority"]),
        ("왜 하는가", "계획 원문: docs/tasks.md"),
        ("할 일", "\n".join(task["todo"])),
        ("완료 기준", task["done"]),
        ("선행 작업", task["after"] or "_No response_"),
    ]
    return "\n\n".join(f"### {name}\n\n{value}" for name, value in sections)


def plan(tasks, issues, parts):
    """할 일을 (동작, 인자) 목록으로 돌려준다. 네트워크를 쓰지 않아 테스트할 수 있다."""
    have = {m[1]: i for i in issues if (m := re.match(r"^\[(T\d+)\] ", i["title"]))}
    actions = []
    for t in tasks:
        label, owner = f"part:{t['part']}", parts[t["part"]]["owner"]
        issue = have.get(t["id"])
        if not issue:
            actions.append(("create", {"title": f"[{t['id']}] {t['title']}", "body": body(t, parts),
                                       "labels": ["type:task", label, t["priority"], "status:backlog"], "assignee": owner}))
            continue
        names = {l["name"] for l in issue["labels"]}
        stale = sorted(n for n in names if n.startswith("part:") and n != label)
        if label not in names or stale:
            actions.append(("label", {"number": issue["number"], "add": label, "remove": stale}))
        if issue["state"] == "OPEN" and not issue["assignees"]:
            actions.append(("assign", {"number": issue["number"], "assignee": owner}))
    return actions


def gh(*args):
    return subprocess.run(["gh", *args, "-R", REPO], capture_output=True, text=True, check=True).stdout


def main():
    parts = json.loads((ROOT / ".github/parts.json").read_text())["parts"]
    tasks = parse((ROOT / "docs/tasks.md").read_text(), parts)
    issues = json.loads(gh("issue", "list", "--state", "all", "--limit", "300", "--json", "number,title,state,labels,assignees"))
    apply = "--apply" in sys.argv
    for kind, a in plan(tasks, issues, parts):
        if kind == "create":
            print(("만듦: " if apply else "만들 예정: ") + f"{a['title']} → {a['assignee']}")
            if apply:
                gh("issue", "create", "--title", a["title"], "--body", a["body"], "--assignee", a["assignee"],
                   *[x for label in a["labels"] for x in ("--label", label)])
        elif kind == "label":
            print(("라벨: " if apply else "라벨 예정: ") + f"#{a['number']} +{a['add']} -{a['remove']}")
            if apply:
                gh("issue", "edit", str(a["number"]), "--add-label", a["add"],
                   *[x for label in a["remove"] for x in ("--remove-label", label)])
        elif kind == "assign":
            print(("담당: " if apply else "담당 예정: ") + f"#{a['number']} → {a['assignee']}")
            if apply:
                gh("issue", "edit", str(a["number"]), "--add-assignee", a["assignee"])


if __name__ == "__main__":
    main()
