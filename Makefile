# 자주 쓰는 명령. 규칙은 docs/development.md에 있다.
.PHONY: hooks check check-fast api db db-stop run image e2e push deploy-tag ticket-start ticket-pr

# 로컬 개발용 Postgres 컨테이너의 접속 주소. CI와 배포 환경은 DATABASE_URL을 따로 준다.
PG_PORT ?= 54329
DATABASE_URL ?= postgres://gachita:gachita@localhost:$(PG_PORT)/gachita
export DATABASE_URL

hooks: ## 커밋 훅과 커밋 양식을 이 저장소에 건다(복제한 뒤 한 번)
	git config core.hooksPath .githooks
	git config commit.template .gitmessage
	@echo "커밋 훅(.githooks)과 커밋 양식(.gitmessage)을 걸었습니다"

check-fast: ## 올리기 전에 도는 빠른 검사(1초 안팎)
	node --check frontend/web/app.js
	node --test "frontend/web/*.test.mjs"

check: check-fast db api ## CI와 같은 검사(로컬 Postgres 컨테이너를 띄운다)

api: ## API 테스트. DATABASE_URL의 Postgres가 떠 있어야 한다
	cd backend/api && npm ci --silent && node --test

db: ## 로컬 Postgres 컨테이너를 띄운다(이미 있으면 그대로)
	@docker start gachita-pg >/dev/null 2>&1 || docker run -d --name gachita-pg -p $(PG_PORT):5432 \
		-e POSTGRES_USER=gachita -e POSTGRES_PASSWORD=gachita -e POSTGRES_DB=gachita postgres:17 >/dev/null
	@until docker exec gachita-pg pg_isready -U gachita -q; do sleep 0.5; done

db-stop: ## 로컬 Postgres 컨테이너를 지운다(데이터도 지워짐)
	docker rm -f gachita-pg

run: db ## API와 웹앱을 http://localhost:8787 에서 실행
	cd backend/api && npm ci --silent && node server.js

# ---- 이미지: 로컬 E2E로 확인하고, develop 병합 때 CI가 GHCR에 올리고, 태그를 바꿔 GitOps로 내보낸다 (docs/development.md) ----
IMAGE ?= ghcr.io/team-pitcrew/gachita-api
TAG ?= $(shell git rev-parse HEAD | cut -c1-12)
OVERLAY ?= backend/infra/gitops/apps/api/overlays/dev/kustomization.yaml

image: ## 서버(ARM)용 이미지를 로컬에서 만든다. API와 웹앱이 한 이미지에 들어간다
	docker buildx build --platform linux/arm64 --load -f backend/api/Dockerfile -t $(IMAGE):$(TAG) .

# E2E는 개발용 gachita-pg를 쓰지 않고 일회용 Postgres를 따로 띄운다. 끝나면 성공·실패와 관계없이 둘 다 지운다.
E2E_PORT ?= 8799
E2E_PG_PORT ?= 54339

e2e: ## 이미지를 만들어 일회용 Postgres와 띄우고 여행 하나의 흐름을 HTTP로 확인한다(CI package와 같은 스크립트)
	docker build -q -f backend/api/Dockerfile -t gachita-api:e2e . >/dev/null
	@docker rm -f gachita-e2e gachita-e2e-pg >/dev/null 2>&1 || true
	@trap 'docker rm -f gachita-e2e gachita-e2e-pg >/dev/null 2>&1' EXIT; \
	docker run -d --name gachita-e2e-pg -p $(E2E_PG_PORT):5432 \
		-e POSTGRES_USER=gachita -e POSTGRES_PASSWORD=gachita -e POSTGRES_DB=gachita postgres:17 >/dev/null || exit 1; \
	until docker exec gachita-e2e-pg pg_isready -h 127.0.0.1 -U gachita -q; do sleep 0.5; done; \
	docker run -d --name gachita-e2e --read-only --user 1000 --add-host host.docker.internal:host-gateway \
		-e DATABASE_URL=postgres://gachita:gachita@host.docker.internal:$(E2E_PG_PORT)/gachita -p $(E2E_PORT):8787 gachita-api:e2e >/dev/null || exit 1; \
	node .github/scripts/e2e.mjs http://localhost:$(E2E_PORT) || { echo "--- 서버 로그"; docker logs gachita-e2e 2>&1 | tail -40; exit 1; }

push: e2e ## E2E를 통과한 뒤 이미지를 GHCR에 올린다(gh 로그인 계정에 write:packages 필요). 평소에는 develop 병합 때 CI가 올린다
	@gh auth token | docker login ghcr.io -u "$$(gh api user --jq .login)" --password-stdin >/dev/null
	docker buildx build --platform linux/arm64 --push -f backend/api/Dockerfile -t $(IMAGE):$(TAG) .
	@echo "올림: $(IMAGE):$(TAG)  다음: make deploy-tag TAG=$(TAG)"

deploy-tag: ## dev 환경이 쓸 이미지 태그를 TAG로 바꾼다. 이 변경을 PR로 올리면 Argo CD가 내보낸다
	perl -pi -e 's/^(\s*newTag:\s*)\S+/$${1}$(TAG)/' $(OVERLAY)
	@grep -n "newTag" $(OVERLAY)

# ---- 티켓: 브랜치와 PR을 규칙대로 만든다. 상태와 라벨은 GitHub에서 자동으로 옮겨진다 ----
ticket-start: ## 예: make ticket-start T=T7 NAME=car-shell
	@.github/scripts/ticket.sh start "$(T)" "$(NAME)"

ticket-pr: ## 지금 브랜치의 티켓으로 PR을 연다
	@.github/scripts/ticket.sh pr
