-- 차량 화면의 5분 초대. 인증 토큰은 넣지 않고 초대 코드의 해시만 보관합니다.
BEGIN;
SELECT pg_advisory_xact_lock(74634);
CREATE TABLE IF NOT EXISTS boarding_invites (
  id uuid PRIMARY KEY,
  code_hash bytea NOT NULL UNIQUE,
  trip_code text NOT NULL REFERENCES trips(code) ON DELETE CASCADE,
  issuer_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS boarding_invites_one_live ON boarding_invites (trip_code) WHERE revoked_at IS NULL;
COMMIT;
