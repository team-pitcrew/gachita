-- 폰이 발급하고 차가 한 번 상환하는 동승 연결(T46). 여행과 같은 DB에서 원자적으로 소진한다.
BEGIN;
SELECT pg_advisory_xact_lock(74628);
CREATE TABLE IF NOT EXISTS ride_links (
  id uuid PRIMARY KEY,
  code_hash bytea NOT NULL UNIQUE,
  profile_id uuid NOT NULL,
  participant_token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  trip_code text,
  participant_id text,
  CHECK ((trip_code IS NULL) = (participant_id IS NULL))
);
CREATE INDEX IF NOT EXISTS ride_links_expires ON ride_links (expires_at);
COMMIT;
