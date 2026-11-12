# 자주 쓰는 명령. 규칙은 docs/development.md에 있다.
.PHONY: hooks check check-fast web api run

hooks: ## 커밋 훅을 이 저장소에 건다(복제한 뒤 한 번)
	git config core.hooksPath .githooks
	@echo "커밋 훅을 걸었습니다: .githooks"

check-fast: ## 올리기 전에 도는 빠른 검사(1초 안팎)
	node --check apps/web/app.js
	node --test "apps/web/*.test.mjs"

check: check-fast api ## CI와 같은 검사

api:
	cd services/api && node --test

run: ## API와 웹앱을 http://localhost:8787 에서 실행
	cd services/api && node server.js
