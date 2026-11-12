"""scope.py와 spec_check.py의 검사. 실행: python3 -m unittest discover -s .github/scripts -p 'test_*.py'"""
import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

import scope
import spec_check

CONFIG = json.loads(scope.CONFIG.read_text())  # 실제 parts.json으로 검사한다
PARTS = ["frontend-spec", "frontend-app", "backend-api", "backend-infra"]


def on(files, full=False):
    """참인 파트 이름과 package 여부."""
    result = scope.plan(files, CONFIG, full)
    return sorted(name for name, yes in result["parts"].items() if yes), result["package"]


class ScopeTest(unittest.TestCase):
    def test_파트_정의가_네_개다(self):
        self.assertEqual(sorted(CONFIG["parts"]), sorted(PARTS))

    def test_한_파트만_바뀌면_그_파트만(self):
        self.assertEqual(on(["frontend/spec/join.md"]), (["frontend-spec"], False))
        self.assertEqual(on(["backend/infra/terraform/compute.tf"]), (["backend-infra"], False))

    def test_두_파트가_바뀌면_둘_다(self):
        self.assertEqual(on(["backend/api/server.js", "backend/infra/gitops/bootstrap/api.yaml"]), (["backend-api", "backend-infra"], True))

    def test_검사를_정하는_파일이_바뀌면_전부(self):
        for file in [".github/workflows/ci.yml", ".github/scripts/scope.py", ".github/scripts/spec_check.py", ".github/parts.json", "Makefile"]:
            self.assertEqual(on([file]), (sorted(PARTS), True), file)

    def test_문서만_바뀌면_아무_파트도_아니다(self):
        self.assertEqual(on(["docs/tasks.md", "docs/adr/0001-gitflow-and-hooks.md", "README.md", "AGENTS.md"]), ([], False))
        self.assertEqual(on(["backend/infra/gitops/README.md", "backend/api/README.md", "frontend/web/README.md"]), ([], False), "파트 폴더 안의 문서")

    def test_협업_설정만_바뀌면_아무_파트도_아니다(self):
        """양식, 티켓 자동화, 훅, 비밀 값 규칙은 scope와 policy 잡이 언제나 본다."""
        files = [".github/ISSUE_TEMPLATE/ticket.yml", ".github/pull_request_template.md", ".github/CODEOWNERS",
                 ".github/workflows/tickets.yml", ".github/scripts/tickets.py", ".githooks/pre-push", ".gitleaks.toml", ".gitmessage"]
        self.assertEqual(on(files), ([], False))
        self.assertEqual(on([".dockerignore"]), ([], True), "이미지에 들어갈 파일을 정하므로 package만")

    def test_API_명세는_백엔드_로직이다(self):
        self.assertEqual(on(["docs/api/openapi.yaml"]), (["backend-api"], False))

    def test_웹앱과_API는_이미지를_다시_만든다(self):
        self.assertEqual(on(["frontend/web/app.js"]), (["frontend-app"], True))
        self.assertEqual(on(["backend/api/Dockerfile"]), (["backend-api"], True))
        self.assertEqual(on(["frontend/car/app/build.gradle"]), (["frontend-app"], False), "차량 앱은 이미지에 안 들어간다")

    def test_인프라는_이미지를_다시_만들지_않는다(self):
        self.assertFalse(on(["backend/infra/gitops/apps/api/base/deployment.yaml"])[1])

    def test_전체_검사는_전부_참(self):
        result = scope.plan([], CONFIG, full=True)
        self.assertEqual((result["full"], all(result["parts"].values()), result["package"]), (True, True, True))

    def test_이름이_비슷한_다른_폴더는_세지_않는다(self):
        self.assertEqual(on(["frontend/webview/x.js", "backend/apidocs/y.md", "Makefile.bak"]), ([], False))

    def test_명령줄과_GITHUB_OUTPUT(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_file = Path(tmp) / "out"
            os.environ["GITHUB_OUTPUT"] = str(out_file)
            try:
                printed = io.StringIO()
                with redirect_stdout(printed):
                    scope.main(["--files", "frontend/web/style.css", "docs/tasks.md"])
            finally:
                del os.environ["GITHUB_OUTPUT"]
            result = json.loads(printed.getvalue())
            self.assertEqual((result["files"], result["parts"]["frontend-app"], result["package"]), (2, True, True))
            self.assertEqual(
                out_file.read_text().split(),
                ["full=false", "package=true", "frontend_spec=false", "frontend_app=true", "backend_api=false", "backend_infra=false"],
            )

    def test_git에서_바뀐_파일을_구한다(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}
            git = lambda *args: subprocess.run(["git", "-c", "core.hooksPath=/dev/null", *args], cwd=tmp, env=env, check=True, capture_output=True, text=True).stdout.strip()
            git("init", "-q", "-b", "develop")
            Path(tmp, "backend/api").mkdir(parents=True)
            Path(tmp, "backend/api/old.js").write_text("x\n")
            git("add", "-A")
            git("commit", "-q", "-m", "base")
            base = git("rev-parse", "HEAD")
            git("switch", "-q", "-c", "feature/T1-x")
            Path(tmp, "docs").mkdir()
            git("mv", "backend/api/old.js", "docs/moved.js")
            git("commit", "-q", "-m", "move")
            # 이름을 바꾼 파일은 떠난 쪽 파트도 검사해야 한다
            self.assertEqual(sorted(scope.changed(base, cwd=tmp)), ["backend/api/old.js", "docs/moved.js"])


GOOD = "# 참가\n\n## 목적\n\n## 흐름\n\n## 화면 요소\n\n## 상태\n\n## 문구\n\n[규칙](README.md) [밖](https://example.com) [안](#상태)\n"


class SpecCheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "frontend" / "spec"
        self.root.mkdir(parents=True)
        (self.root / "README.md").write_text("# 규칙\n")          # 검사 대상이 아니다
        (self.root / "_template.md").write_text("# 양식\n")       # 검사 대상이 아니다

    def tearDown(self):
        self.tmp.cleanup()

    def check(self):
        return spec_check.check(self.root, repo=Path(self.tmp.name))

    def test_문서가_없으면_통과(self):
        self.assertEqual(self.check(), (0, []))
        self.assertEqual(spec_check.check(self.root / "없는폴더"), (0, []))

    def test_틀을_지킨_문서는_통과(self):
        (self.root / "join.md").write_text(GOOD)
        self.assertEqual(self.check(), (1, []))

    def test_빠진_제목을_알려_준다(self):
        (self.root / "join.md").write_text(GOOD.replace("## 상태\n", "").replace("## 문구\n", "```\n## 문구\n```\n"))
        count, problems = self.check()
        self.assertEqual(count, 1)
        self.assertEqual(problems, ["frontend/spec/join.md: 제목 '## 상태'가 없습니다", "frontend/spec/join.md: 제목 '## 문구'가 없습니다"])

    def test_깨진_링크를_알려_준다(self):
        (self.root / "car").mkdir()
        (self.root / "car" / "recording.md").write_text(GOOD.replace("(README.md)", "(../README.md)") + "[없음](../missing.md#흐름) ![그림](shot.png)\n")
        count, problems = self.check()
        self.assertEqual(count, 1)
        self.assertEqual(problems, [
            "frontend/spec/car/recording.md: 링크 '../missing.md#흐름'가 가리키는 파일이 없습니다",
            "frontend/spec/car/recording.md: 링크 'shot.png'가 가리키는 파일이 없습니다",
        ])

    def test_명령줄_종료_코드(self):
        (self.root / "bad.md").write_text("# 제목만\n")
        with redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(spec_check.main([str(self.root)]), 1)
        self.assertIn("고칠 곳 5건", printed.getvalue())


if __name__ == "__main__":
    unittest.main()
