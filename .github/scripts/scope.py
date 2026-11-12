#!/usr/bin/env python3
"""바뀐 파일을 보고 어느 파트의 검사를 돌릴지 정한다. 파트와 경로의 원본은 .github/parts.json이다.

    python3 .github/scripts/scope.py --base <sha>     # PR: base와 HEAD 사이에 바뀐 파일로 정한다
    python3 .github/scripts/scope.py --full           # 전부 검사한다(push, 수동 실행)
    python3 .github/scripts/scope.py --files a b c    # 파일을 직접 준다(테스트와 확인용)

결과는 JSON 한 줄이다. GITHUB_OUTPUT이 있으면 frontend_spec=true 같은 줄도 적는다.
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

CONFIG = Path(__file__).resolve().parents[1] / "parts.json"


def under(path, prefixes):
    """path가 prefixes 가운데 하나와 같거나 그 폴더 아래인가."""
    for prefix in prefixes:
        root = prefix.rstrip("/")
        if path == root or path.startswith(root + "/"):
            return True
    return False


def plan(files, config, full=False):
    """바뀐 파일 목록으로 파트별 검사 여부와 이미지 빌드 여부를 정한다."""
    files = [f for f in files if f]
    # 문서(.md)는 화면 문서(frontend/spec)만 검사 대상이다. 다른 문서는 어느 파트의 검사도 깨뜨리지 못한다.
    spec = config["parts"]["frontend-spec"]["paths"]
    code = [f for f in files if not f.endswith(".md") or under(f, spec)]
    shared = full or any(under(f, config["shared"]) for f in code)
    return {
        "full": full,
        "parts": {name: shared or any(under(f, part["paths"]) for f in code) for name, part in config["parts"].items()},
        "package": shared or any(under(f, config["package"]) for f in code),
        "files": len(files),
    }


def changed(base, cwd=None):
    """base와 HEAD 사이에 바뀐 파일. 이름을 바꾼 파일은 옛 경로와 새 경로를 모두 센다."""
    out = subprocess.run(["git", "diff", "--name-only", "--no-renames", f"{base}...HEAD"],
                         capture_output=True, text=True, check=True, cwd=cwd).stdout
    return out.splitlines()


def main(argv=None):
    parser = argparse.ArgumentParser(description="검사 범위 정하기")
    how = parser.add_mutually_exclusive_group(required=True)
    how.add_argument("--base", help="PR의 base 커밋")
    how.add_argument("--full", action="store_true", help="전부 검사")
    how.add_argument("--files", nargs="*", help="바뀐 파일을 직접 준다")
    args = parser.parse_args(argv)

    config = json.loads(CONFIG.read_text())
    if args.full:
        result = plan([], config, full=True)
    elif args.files is not None:
        result = plan(args.files, config)
    else:
        try:
            result = plan(changed(args.base), config)
        except subprocess.CalledProcessError as e:
            # 범위를 알 수 없으면 덜 검사하지 않고 전부 검사한다
            print(f"바뀐 파일을 구하지 못해 전부 검사합니다: {e.stderr.strip()}", file=sys.stderr)
            result = plan([], config, full=True)

    print(json.dumps(result, ensure_ascii=False))
    if os.environ.get("GITHUB_OUTPUT"):
        flags = {"full": result["full"], "package": result["package"], **result["parts"]}
        with open(os.environ["GITHUB_OUTPUT"], "a") as out:
            for name, on in flags.items():
                out.write(f"{name.replace('-', '_')}={'true' if on else 'false'}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
