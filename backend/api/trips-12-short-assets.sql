BEGIN;
SELECT pg_advisory_xact_lock(74635);
-- 여행이 지워져도 S3 정리 키를 잃지 않도록 FK로 바로 지우지 않습니다.
CREATE TABLE IF NOT EXISTS short_assets (
  id uuid PRIMARY KEY,
  trip_code text NOT NULL,
  participant_id text NOT NULL,
  generation integer NOT NULL,
  moment_id text NOT NULL,
  source_hash text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  sha256 text NOT NULL,
  media jsonb NOT NULL,
  object_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('uploading','completed','failed','deleted')),
  attempt uuid NOT NULL,
  lease_until timestamptz NOT NULL,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(trip_code,participant_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS short_assets_trip ON short_assets(trip_code,generation,created_at DESC);
CREATE INDEX IF NOT EXISTS short_assets_check ON short_assets(next_check_at) WHERE state<>'deleted';
CREATE TABLE IF NOT EXISTS short_asset_trash (
  object_key text PRIMARY KEY,
  version bigint NOT NULL DEFAULT 1,
  ready_at timestamptz NOT NULL DEFAULT now(),
  since timestamptz NOT NULL DEFAULT now()
);
COMMIT;
