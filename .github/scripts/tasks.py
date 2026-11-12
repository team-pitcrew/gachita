#!/usr/bin/env python3
"""docs/tasks.md의 작업을 GitHub 이슈로 만든다. 이미 있는 T번호는 건드리지 않는다.

    python3 .github/scripts/tasks.py            # 무엇을 만들지만 보여 준다
    python3 .github/scripts/tasks.py --apply    # 없는 이슈를 만든다

이슈가 생긴 뒤의 체크와 상태는 이슈가 기준이다. 이 스크립트는 이슈 본문을 덮어쓰지 않는다.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

REPO = "team-pitcrew/gachita"
HEAD = re.compile(r"^### (T\d+) (.+?) \((P[012])\)(?: · 선행 (.+))?$")


def parse(text):
    tasks, cur = [], None
    for line in text.splitlines():
        m = HEAD.match(line)
        if m:
            cur = {"id": m[1], "title": m[2], "priority": m[3], "after": m[4] or "", "todo": [], "done": ""}
            tasks.append(cur)
        elif line.startswith(("## ", "### ")):
            cur = None
        elif cur and line.startswith("- [ ] "):
            cur["todo"].append(line)
        elif cur and line.startswith("완료 기준:"):
            cur["done"] = line.removeprefix("완료 기준:").strip()
    return tasks


def body(t):
    after = f"\n\n## 선행 작업\n\n{t['after']}" if t["after"] else ""
    return "## 할 일\n\n" + "\n".join(t["todo"]) + f"\n\n## 완료 기준\n\n{t['done']}{after}\n\n계획 원문: docs/tasks.md"


def main():
    tasks = parse(Path(__file__).resolve().parents[2].joinpath("docs/tasks.md").read_text())
    assert tasks and all(t["todo"] and t["done"] for t in tasks), "할 일이나 완료 기준이 빈 작업이 있음"
    assert len({t["id"] for t in tasks}) == len(tasks), "T번호가 겹침"
    out = subprocess.run(["gh", "issue", "list", "-R", REPO, "--state", "all", "--limit", "200", "--json", "title"],
                         capture_output=True, text=True, check=True).stdout
    have = {m[1] for i in json.loads(out) if (m := re.match(r"^\[(T\d+)\] ", i["title"]))}
    for t in tasks:
        if t["id"] in have:
            continue
        title = f"[{t['id']}] {t['title']}"
        print(("만듦: " if "--apply" in sys.argv else "만들 예정: ") + title)
        if "--apply" in sys.argv:
            subprocess.run(["gh", "issue", "create", "-R", REPO, "--title", title, "--body", body(t),
                            "--label", t["priority"], "--label", "status:backlog"], check=True, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
