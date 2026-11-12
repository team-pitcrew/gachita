#!/usr/bin/env python3
"""프론트 설계 문서(frontend/spec, 피그마 전 단계)가 정한 틀을 지키는지 본다.

    python3 .github/scripts/spec_check.py [폴더]

README.md와 _template.md를 뺀 .md 파일마다
  - 아래 다섯 제목이 모두 있어야 하고
  - 본문의 상대 링크가 가리키는 파일이 있어야 한다.
코드 블록(```) 안은 보지 않는다.
"""
import re
import sys
from pathlib import Path
from urllib.parse import unquote

REPO = Path(__file__).resolve().parents[2]
REQUIRED = ["## 목적", "## 흐름", "## 화면 요소", "## 상태", "## 문구"]
SKIP = {"README.md", "_template.md"}
LINK = re.compile(r"\]\(\s*<?([^)\s>]+)")
OUTSIDE = ("http://", "https://", "mailto:", "#")


def check_file(path, repo=REPO):
    """한 문서의 문제를 문장 목록으로 돌려준다."""
    headings, links, fenced = set(), [], False
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.lstrip().startswith("```"):
            fenced = not fenced
            continue
        if fenced:
            continue
        headings.add(line.strip())
        links += LINK.findall(line)

    problems = [f"제목 '{h}'가 없습니다" for h in REQUIRED if h not in headings]
    for link in links:
        if link.startswith(OUTSIDE):
            continue
        target = unquote(link.split("#")[0].split("?")[0])
        if not target:
            continue
        # /로 시작하면 저장소 루트 기준, 아니면 문서가 있는 폴더 기준
        file = repo / target.lstrip("/") if target.startswith("/") else path.parent / target
        if not file.exists():
            problems.append(f"링크 '{link}'가 가리키는 파일이 없습니다")
    return problems


def check(root, repo=REPO):
    """폴더 아래 화면 문서를 모두 본다. (문서 수, 문제 목록)을 돌려준다."""
    docs = sorted(p for p in Path(root).rglob("*.md") if p.name not in SKIP) if Path(root).is_dir() else []
    problems = []
    for doc in docs:
        try:
            name = doc.relative_to(repo)
        except ValueError:
            name = doc
        problems += [f"{name}: {problem}" for problem in check_file(doc, repo)]
    return len(docs), problems


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    root = Path(argv[0]) if argv else REPO / "frontend" / "spec"
    count, problems = check(root)
    if count == 0:
        print("검사할 화면 문서가 없습니다")
        return 0
    if problems:
        print("\n".join(problems))
        print(f"화면 문서 {count}개 가운데 고칠 곳 {len(problems)}건")
        return 1
    print(f"화면 문서 {count}개 통과")
    return 0


if __name__ == "__main__":
    sys.exit(main())
