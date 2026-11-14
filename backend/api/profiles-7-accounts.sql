-- 프로필에 이메일 계정과 계정 동의를 더한다(T128, 2026-11-14). 최종 디자인의 공유 계정(C02)과 한 번 받는 녹음 동의(C03).
-- 계정은 기존 프로필 한 줄에 붙는다: 기기 프로필·구글 연결은 그대로고, 같은 프로필에 이메일·비밀번호가 더해진다.
-- 칸은 모두 비어 있어도 되거나 기본값이 있어, 옛 이미지와 함께 돌거나 되돌려도 옛 코드는 이 칸을 읽지 않는다.
BEGIN;
SELECT pg_advisory_xact_lock(74640); -- 서버 여러 대가 동시에 시작해도 한 번에 하나만 실행

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email text;            -- 소문자로 정규화해 둔다. 계정이 없으면 비어 있음
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS password_hash text;    -- scrypt:N:r:p:<소금 base64>:<값 base64>. 원문은 어디에도 없다
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS consent boolean NOT NULL DEFAULT false; -- 계정의 녹음 동의(아이는 보호자 동의)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS consent_at timestamptz; -- 동의한 시각. 동의가 꺼지면 비운다
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS consent_version text NOT NULL DEFAULT ''; -- 동의한 문구의 판
CREATE UNIQUE INDEX IF NOT EXISTS profiles_email ON profiles (email) WHERE email IS NOT NULL;

COMMIT;
