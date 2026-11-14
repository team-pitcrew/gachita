-- T103: 원문은 utterances에만 두고 장소별 할 일의 사용자 상태만 저장합니다.
BEGIN;
SELECT pg_advisory_xact_lock(74627);
CREATE TABLE IF NOT EXISTS todo_states (
  trip_code text NOT NULL REFERENCES trips(code) ON DELETE CASCADE,
  generation integer NOT NULL CHECK (generation > 0),
  id text NOT NULL CHECK (id ~ '^[0-9a-f]{32}$'),
  status text NOT NULL CHECK (status IN ('pending', 'done', 'cancelled')),
  version integer NOT NULL CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_code, generation, id)
);
COMMIT;
