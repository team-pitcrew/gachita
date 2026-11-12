# 자주 쓰는 명령. 규칙은 docs/development.md에 있다.
.PHONY: hooks check check-fast api db db-stop run

# 로컬 개발용 Postgres 컨테이너의 접속 주소. CI와 배포 환경은 DATABASE_URL을 따로 준다.
PG_PORT ?= 54329
DATABASE_URL ?= postgres://gachita:gachita@localhost:$(PG_PORT)/gachita
export DATABASE_URL

hooks: ## 커밋 훅을 이 저장소에 건다(복제한 뒤 한 번)
	git config core.hooksPath .githooks
	@echo "커밋 훅을 걸었습니다: .githooks"

check-fast: ## 올리기 전에 도는 빠른 검사(1초 안팎)
	node --check apps/web/app.js
	node --test "apps/web/*.test.mjs"

check: check-fast db api ## CI와 같은 검사(로컬 Postgres 컨테이너를 띄운다)

api: ## API 테스트. DATABASE_URL의 Postgres가 떠 있어야 한다
	cd services/api && npm ci --silent && node --test

db: ## 로컬 Postgres 컨테이너를 띄운다(이미 있으면 그대로)
	@docker start gachita-pg >/dev/null 2>&1 || docker run -d --name gachita-pg -p $(PG_PORT):5432 \
		-e POSTGRES_USER=gachita -e POSTGRES_PASSWORD=gachita -e POSTGRES_DB=gachita postgres:17 >/dev/null
	@until docker exec gachita-pg pg_isready -U gachita -q; do sleep 0.5; done

db-stop: ## 로컬 Postgres 컨테이너를 지운다(데이터도 지워짐)
	docker rm -f gachita-pg

run: db ## API와 웹앱을 http://localhost:8787 에서 실행
	cd services/api && npm ci --silent && node server.js
