BEGIN;
SELECT pg_advisory_xact_lock(74628);
CREATE TABLE IF NOT EXISTS short_generations (
 id uuid PRIMARY KEY,
 trip_code text NOT NULL,
 participant_id text NOT NULL,
 generation integer NOT NULL,
 moment_id text NOT NULL,
 idempotency_key text NOT NULL,
 request_hash text NOT NULL,
 plan jsonb NOT NULL,
 source_key text NOT NULL,
 state text NOT NULL DEFAULT 'queued',
 shots jsonb NOT NULL DEFAULT '[]',
 object_keys jsonb NOT NULL DEFAULT '[]',
 result_key text,
 bytes integer,
 error_code text,
 cleanup_pending boolean NOT NULL DEFAULT false,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(trip_code,participant_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS short_generations_pending ON short_generations(next_attempt_at) WHERE state NOT IN ('completed','failed','canceled','submission_unknown');
CREATE INDEX IF NOT EXISTS short_generations_trip ON short_generations(trip_code);
COMMIT;
