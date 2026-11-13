BEGIN;
SELECT pg_advisory_xact_lock(74631);
CREATE TABLE IF NOT EXISTS result_shares (
  id uuid PRIMARY KEY,
  trip_code text NOT NULL REFERENCES trips(code) ON DELETE CASCADE,
  moment_id text NOT NULL,
  sender_id uuid NOT NULL,
  recipient_ids uuid[] NOT NULL,
  generation integer NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS result_shares_trip ON result_shares(trip_code);
CREATE INDEX IF NOT EXISTS result_shares_sender ON result_shares(sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS result_shares_recipients ON result_shares USING gin(recipient_ids);
-- 혼재 배포·되돌리기의 구 서버도 동의 세대를 바꾸므로 공유한 문구는 같은 트랜잭션에서 지워진다.
CREATE OR REPLACE FUNCTION erase_shares_on_consent_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(NEW.doc->>'generation', '1') IS DISTINCT FROM COALESCE(OLD.doc->>'generation', '1') THEN
    DELETE FROM result_shares WHERE trip_code = NEW.code;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS erase_result_shares ON trips;
CREATE TRIGGER erase_result_shares AFTER UPDATE OF doc ON trips
  FOR EACH ROW EXECUTE FUNCTION erase_shares_on_consent_change();
COMMIT;
