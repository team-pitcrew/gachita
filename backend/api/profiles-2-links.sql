-- 프로필 표에 OAuth 연결 칸을 더한다(T21, 2026-11-13). 기존 기기 프로필은 빈 값으로 그대로 읽힌다.
-- 번호 붙은 첫 마이그레이션이다. profiles.sql은 첫 표를 만들고, 이 파일부터는 고치는 내용을 쌓는다.
-- ponytail: 한 프로필에 제공자 연결은 하나. 여러 제공자·여러 기기 토큰은 필요해질 때 다시 나눈다.
BEGIN;
SELECT pg_advisory_xact_lock(74620); -- 서버 여러 대가 동시에 시작해도 한 번에 하나만 실행

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT '';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS provider_user_id text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS profiles_provider_identity ON profiles (provider, provider_user_id) WHERE provider <> '';

COMMIT;
