#!/usr/bin/env python3
"""GitHub 이슈를 티켓으로 쓰는 자동화. .github/workflows/tickets.yml이 부른다.

    tickets.py issue    # 이슈가 열리거나 고쳐짐: 번호, 라벨, 담당
    tickets.py pr       # PR이 열리거나 닫힘: 연결된 티켓의 상태, PR의 파트 라벨
    tickets.py branch   # feature/T7-… 브랜치가 생김: 그 티켓을 작업 중으로

이벤트는 GITHUB_EVENT_PATH의 JSON에서 읽는다. 제목·본문·브랜치 이름은 남이 쓴 글이므로
셸 문자열에 넣지 않고 gh에 인자로만 넘긴다. TICKETS_DRY_RUN=1이면 쓰는 호출을 출력만 한다.
파트와 담당의 원본은 .github/parts.json이다.
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

REPO = os.environ.get("GITHUB_REPOSITORY", "team-pitcrew/gachita")
ORG = REPO.split("/")[0]
CONFIG = json.loads(Path(__file__).resolve().parents[1].joinpath("parts.json").read_text())
PARTS = CONFIG["parts"]
DRY = bool(os.environ.get("TICKETS_DRY_RUN"))

# 상태 라벨(status:*)과 프로젝트 보드 Status 열의 이름
PROJECT_STATUS = {"backlog": "Backlog", "ready": "Ready", "in-progress": "In progress", "in-review": "In review", "done": "Done"}
PRIORITIES = ["P0", "P1", "P2"]
T_TITLE = re.compile(r"^\[T(\d+)\] ")


# ---------- 글에서 읽어 내기 (네트워크 없음) ----------

def sections(body):
    """이슈 양식이 만든 본문을 '### 제목' 단위로 나눈다."""
    out, key = {}, None
    for line in (body or "").splitlines():
        if line.startswith("### "):
            key = line[4:].strip()
            out[key] = []
        elif key is not None:
            out[key].append(line)
    return {k: "\n".join(v).strip() for k, v in out.items()}


def part_of(body):
    """'### 파트'의 값(이름 또는 키)에 맞는 파트 키. 없으면 None."""
    value = (sections(body).get("파트", "").splitlines() or [""])[0].strip()
    return next((key for key, p in PARTS.items() if value in (key, p["name"])), None)


def priority_of(body):
    """'### 우선순위'의 P0~P2. 결함은 '### 심각도'로 정한다(S0·S1 → P0, S2 → P1, S3 → P2)."""
    s = sections(body)
    m = re.match(r"(P[012])\b", s.get("우선순위", ""))
    if m:
        return m[1]
    sev = re.match(r"S([0-3])\b", s.get("심각도", ""))
    return ["P0", "P0", "P1", "P2"][int(sev[1])] if sev else None


def needs_emulator(body):
    """Pleos 에뮬레이터에서 봐야 하는 티켓인가. 작업은 '필요한 환경', 결함은 '확인한 환경'으로 안다."""
    s = sections(body)
    return any(s.get(key, "").startswith("에뮬레이터") for key in ("필요한 환경", "확인한 환경"))


def owner_of(body):
    """담당. 에뮬레이터가 필요한 티켓은 파트와 관계없이 에뮬레이터 담당에게 간다. 파트를 모르면 None."""
    part = part_of(body)
    if not part:
        return None
    return CONFIG["emulator_owner"] if needs_emulator(body) else PARTS[part]["owner"]


def t_number(title):
    m = T_TITLE.match(title or "")
    return int(m[1]) if m else None


def next_number(titles):
    """모든 이슈 제목의 T번호 최댓값 + 1."""
    return max((t_number(t) or 0 for t in titles), default=0) + 1


def planned_numbers(text):
    """작업 목록(docs/tasks.md)에 미리 적은 T번호. 양식으로 만든 티켓이 이 번호를 가져가지 않게 한다."""
    return [int(n) for n in re.findall(r"^### T(\d+) ", text or "", re.M)]


def numbered_title(title, n):
    """번호가 없으면 붙인다. 양식의 자리 표시 '[T] '는 지운다."""
    if t_number(title) is not None:
        return title
    return f"[T{n}] " + re.sub(r"^\[T\]\s*", "", title or "").strip()


def needs_number(title, body):
    """양식으로 만든 티켓(파트가 있거나 자리 표시가 남음)인데 번호가 없는가."""
    return t_number(title) is None and (part_of(body) is not None or (title or "").startswith("[T]"))


def pr_tickets(title, branch, body):
    """PR이 가리키는 티켓. t는 T번호, refs와 closes는 이슈 번호."""
    t = {int(n) for n in re.findall(r"\[T(\d+)\]", title or "")}
    n = branch_ticket(branch)
    if n:
        t.add(n)
    closes = {int(n) for n in re.findall(r"(?i)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)", body or "")}
    refs = {int(n) for n in re.findall(r"(?i)\brefs?\s+#(\d+)", body or "")} - closes
    return {"t": t, "refs": refs, "closes": closes}


def branch_ticket(ref):
    m = re.match(r"^(?:refs/heads/)?(?:feature|hotfix)/T(\d+)-", ref or "")
    return int(m[1]) if m else None


def pr_state(action, merged, closes):
    """PR에 일이 생겼을 때 연결된 티켓이 갈 상태."""
    if action != "closed":
        return "in-review"
    return "done" if merged and closes else "in-progress"


def file_parts(files):
    """바뀐 파일이 속한 파트 키들."""
    return sorted(key for key, p in PARTS.items() if any(f.startswith(path) for f in files for path in p["paths"]))


def label_plan(labels, part=None, priority=None, state=None):
    """붙일 라벨과 뗄 라벨. 파트·우선순위·상태는 각각 하나만 남긴다."""
    add, remove = [], []
    for want, mine in (
        (part and f"part:{part}", lambda l: l.startswith("part:")),
        (priority, lambda l: l in PRIORITIES),
        (state and f"status:{state}", lambda l: l.startswith("status:")),
    ):
        if not want:
            continue
        if want not in labels:
            add.append(want)
        remove += [l for l in labels if mine(l) and l != want]
    return sorted(add), sorted(remove)


def status_of(labels):
    return next((l.removeprefix("status:") for l in labels if l.startswith("status:")), None)


def status_option(options, state):
    """프로젝트 Status 필드의 선택지 중 이 상태에 해당하는 것의 id."""
    want = PROJECT_STATUS[state].lower()
    return next((o["id"] for o in options if o["name"].strip().lower() == want), None)


def graphql_args(query, variables):
    """gh api graphql에 넘길 인자. 정수는 -F, 글자는 -f."""
    args = ["api", "graphql", "-f", f"query={query}"]
    for k, v in variables.items():
        args += ["-F" if isinstance(v, int) else "-f", f"{k}={v}"]
    return args


# ---------- GitHub 부르기 ----------

def gh(*args, write=False, token=None):
    if write and DRY:
        print("DRY gh " + " ".join(args))
        return ""
    env = {**os.environ, **({"GH_TOKEN": token} if token else {})}
    r = subprocess.run(["gh", *args], capture_output=True, text=True, env=env)
    if r.returncode:
        raise RuntimeError(f"gh {' '.join(args[:3])} 실패: {r.stderr.strip()[:300]}")
    return r.stdout


def list_issues():
    out = gh("issue", "list", "-R", REPO, "--state", "all", "--limit", "1000", "--json", "number,title,body,labels,assignees,state,id")
    issues = json.loads(out)
    for i in issues:
        i["labels"] = [l["name"] for l in i["labels"]]
    return issues


def set_labels(number, add, remove):
    for name in remove:
        try:
            gh("api", "-X", "DELETE", f"repos/{REPO}/issues/{number}/labels/{quote(name, safe='')}", write=True)
        except RuntimeError as e:
            # 브랜치와 PR 이벤트가 몇 초 사이에 겹치면 다른 실행이 먼저 뗀다. 이미 없는 라벨은 뗀 것으로 본다.
            if "HTTP 404" not in str(e):
                raise
    if add:
        gh("api", "-X", "POST", f"repos/{REPO}/issues/{number}/labels", *[x for name in add for x in ("-f", f"labels[]={name}")], write=True)


PROJECT_META = """query($org: String!, $number: Int!) { organization(login: $org) { projectV2(number: $number) {
  id field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } } } } }"""
ADD_ITEM = """mutation($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: {projectId: $project, contentId: $content}) { item { id } } }"""
SET_STATUS = """mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: {projectId: $project, itemId: $item, fieldId: $field,
    value: {singleSelectOptionId: $option}}) { projectV2Item { id } } }"""


def sync_project(content_id, state):
    """이슈나 PR을 조직 프로젝트에 넣고 Status를 맞춘다. 토큰이나 번호가 없으면 건너뛴다.

    2026-11-13에 로컬 토큰으로 실제 보드에 돌려 확인했다. 워크플로 안에서(PROJECT_TOKEN으로) 도는 것은 아직 보지 못했다.
    보드가 없거나 열 이름이 달라도 티켓 라벨은 이미 맞춰졌으므로 경고만 남긴다.
    """
    token, number = os.environ.get("PROJECT_TOKEN"), os.environ.get("PROJECT_NUMBER")
    if not (token and number and state):
        return
    try:
        meta = json.loads(gh(*graphql_args(PROJECT_META, {"org": ORG, "number": int(number)}), token=token))
        project = meta["data"]["organization"]["projectV2"]
        option = status_option(project["field"]["options"], state)
        added = gh(*graphql_args(ADD_ITEM, {"project": project["id"], "content": content_id}), write=True, token=token)
        if not option:
            print(f"::warning::프로젝트 Status에 '{PROJECT_STATUS[state]}' 열이 없습니다")
            return
        item = json.loads(added)["data"]["addProjectV2ItemById"]["item"]["id"] if added else "DRY"
        gh(*graphql_args(SET_STATUS, {"project": project["id"], "item": item, "field": project["field"]["id"], "option": option}), write=True, token=token)
    except Exception as e:  # 보드 연동 실패가 티켓 처리를 막지 않게 한다
        print(f"::warning::프로젝트 보드에 반영하지 못했습니다: {e}")


def move(issue, state):
    add, remove = label_plan(issue["labels"], state=state)
    if add or remove:
        set_labels(issue["number"], add, remove)
        print(f"#{issue['number']} → {state}")
    sync_project(issue["id"], state)


# ---------- 이벤트 ----------

def on_issue(event):
    """열려 있는 이슈를 모두 훑는다. 이벤트가 몰려 일부 실행이 취소돼도 마지막 실행이 빠진 것을 채운다."""
    issues = list_issues()
    # 기본 브랜치의 작업 목록에 이미 적힌 번호도 쓴 것으로 본다(tickets.yml이 기본 브랜치를 체크아웃한다).
    # ponytail: 아직 병합되지 않은 PR이 작업 목록에 더하는 번호는 못 본다. 그 겹침은 tasks.py가 제목을 보고 막는다.
    tasks_md = Path(__file__).resolve().parents[2] / "docs" / "tasks.md"
    planned = planned_numbers(tasks_md.read_text()) if tasks_md.exists() else []
    top = max([next_number(i["title"] for i in issues) - 1, *planned])
    changed_here = (event.get("issue") or {}).get("number")
    for i in sorted(issues, key=lambda i: i["number"]):
        if i["state"] != "OPEN":
            continue
        n, changed = i["number"], i["number"] == changed_here
        if needs_number(i["title"], i["body"]):
            top += 1
            title = numbered_title(i["title"], top)
            gh("api", "-X", "PATCH", f"repos/{REPO}/issues/{n}", "-f", f"title={title}", write=True)
            print(f"#{n} 번호: {title}")
            changed = True
        part = part_of(i["body"])
        state = None if status_of(i["labels"]) else "backlog"
        add, remove = label_plan(i["labels"], part=part, priority=priority_of(i["body"]), state=state)
        if needs_emulator(i["body"]) and "env:emulator" not in i["labels"]:
            add = sorted(add + ["env:emulator"])
        if add or remove:
            set_labels(n, add, remove)
            print(f"#{n} 라벨: +{add} -{remove}")
            changed = True
        owner = owner_of(i["body"])
        if owner and not i["assignees"]:
            gh("api", "-X", "POST", f"repos/{REPO}/issues/{n}/assignees", "-f", f"assignees[]={owner}", write=True)
            print(f"#{n} 담당: {owner}")
            changed = True
        if changed:
            sync_project(i["id"], status_of(i["labels"]) or "backlog")


def on_pr(event):
    pr, action = event["pull_request"], event["action"]
    info = pr_tickets(pr["title"], pr["head"]["ref"], pr.get("body"))
    issues = {i["number"]: i for i in list_issues()}
    by_t = {t_number(i["title"]): i for i in issues.values() if t_number(i["title"])}
    targets = {}  # 이슈 번호 → Closes로 연결됐는가
    for t in info["t"]:
        if t in by_t:
            targets.setdefault(by_t[t]["number"], False)
    for n in info["refs"] & issues.keys():
        targets.setdefault(n, False)
    for n in info["closes"] & issues.keys():
        targets[n] = True
    merged = bool(pr.get("merged"))
    for n, closes in sorted(targets.items()):
        state = pr_state(action, merged, closes)
        if issues[n]["state"] != "OPEN" and state != "done":
            continue  # 이미 닫힌 티켓은 되돌리지 않는다
        move(issues[n], state)
    if action != "closed":
        files = gh("api", "--paginate", f"repos/{REPO}/pulls/{pr['number']}/files", "--jq", ".[].filename").split("\n")
        have = [l["name"] for l in pr.get("labels", [])]
        add = [f"part:{p}" for p in file_parts(files) if f"part:{p}" not in have]
        if add:
            set_labels(pr["number"], add, [])
            print(f"PR #{pr['number']} 라벨: +{add}")
        sync_project(pr["node_id"], "in-review")
    elif merged:
        sync_project(pr["node_id"], "done")


def on_branch(event):
    if event.get("ref_type") != "branch":
        return
    t = branch_ticket(event.get("ref"))
    issue = next((i for i in list_issues() if t and t_number(i["title"]) == t), None)
    # 시작 전인 티켓만 옮긴다. 리뷰 중이거나 끝난 것은 그대로 둔다.
    if issue and issue["state"] == "OPEN" and status_of(issue["labels"]) in (None, "backlog", "ready"):
        move(issue, "in-progress")


def main():
    handlers = {"issue": on_issue, "pr": on_pr, "branch": on_branch}
    if len(sys.argv) != 2 or sys.argv[1] not in handlers:
        sys.exit(__doc__)
    handlers[sys.argv[1]](json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text()))


if __name__ == "__main__":
    main()
