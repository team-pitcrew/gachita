-- 여행 전체 음성(ADR-0024, 2026-11-14). 주차한 뒤 차가 여행의 원음 전체(16 kHz 모노 s16le PCM)를 조각으로 올리고,
-- 서버는 조각을 클립 버킷에 따로 두었다가 완료 때 순서대로 이어 객체 하나로 둔다. 장면 클립은 그 객체에서 잘라
-- 일반 클립 줄(recordings)로 남긴다(cut_from_audio). 소리는 버킷에, 여기에는 정보만 둔다.
-- 보관: 다 올린 뒤 2일(11/15 오너 결정 "Expire after 2 days"). 서버의 10분 치우기가 clip_trash로 지우고(버킷에는 시간 규칙 없음, T145),
-- API는 ready_at에서 2일이 지났거나 버킷에 없으면(404) 만료로 보고 장면을 자르지 않는다. 장면 클립은 시간으로 지우지 않는다.
-- 객체 키는 '<여행>/trip-audio/…'(장면 클립과 다른 접두어).
-- 지우기: 동의 세대가 오르거나(누구든 철회) 여행 줄이 지워지면 아래 트리거가 같은 트랜잭션에서 키를 clip_trash에 적고
-- 줄을 지운다 — 어느 판의 서버가 세대를 올리든 지워지게(옛 이미지도 clip_trash는 비운다). 버킷은 커밋 뒤에 비운다.
BEGIN;
SELECT pg_advisory_xact_lock(74650); -- 서버 여러 대가 동시에 시작해도 한 번에 하나만 실행

-- 여행마다 한 줄. 올리는 중(upload_id가 있음)과 다 올린 것(object_key가 있음)을 함께 둔다:
-- 다시 출발해 새로 올리는 동안에도 앞서 올린 전체 음성으로 장면을 자를 수 있게, 새것을 다 올리면 바꿔 끼운다.
-- deleted_at은 사람이 지운 표시다. 그 세대의 전체 음성은 다시 받지 않는다(세대가 오르면 줄째 지워진다).
CREATE TABLE IF NOT EXISTS trip_audio (
  trip_code text PRIMARY KEY REFERENCES trips(code) ON DELETE CASCADE,
  generation int NOT NULL,                   -- 녹음할 때의 동의 세대(ADR-0007)
  participant_id text NOT NULL,              -- 올린 참가자(그 여행의 발화를 올린 기기의 주인)
  upload_id uuid,                            -- 올리는 중인 것. 없으면 올리는 중이 아님
  expected_bytes bigint,
  upload_seconds double precision,
  upload_started_at bigint,                  -- 첫 표본의 시각(epoch ms). 장면 구간을 바이트로 바꾸는 기준
  assembling_until timestamptz,              -- 완료(합치기) 중. 이 시각까지 다른 완료를 받지 않는다
  object_key text,                           -- 다 올린 전체 음성(헤더 없는 PCM)
  bytes bigint,
  seconds double precision,
  started_at bigint,
  sha256 text,
  part_count int,
  ready_at timestamptz,
  expired_at timestamptz,                    -- 만료(다 올린 뒤 2일, 서버 치우기가 지움). ready_at에서 2일이 지나도 만료로 본다
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 받은 조각. 같은 n을 다시 받으면 줄을 바꾸고 앞의 키는 clip_trash로 보낸다(키는 받을 때마다 달라 동시에 받아도 섞이지 않음).
CREATE TABLE IF NOT EXISTS trip_audio_parts (
  trip_code text NOT NULL REFERENCES trip_audio(trip_code) ON DELETE CASCADE,
  upload_id uuid NOT NULL,
  n int NOT NULL,
  bytes int NOT NULL,
  object_key text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_code, upload_id, n)
);

-- 전체 음성에서 서버가 자른 클립. 전체 음성을 지울 때 함께 지운다(차가 올린 클립은 따로 지운다).
-- 칸이 있으면 ALTER를 부르지 않는다(trips-5-voice.sql과 같은 까닭: 뜰 때마다 recordings를 배타적으로 잠그지 않게).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'recordings' AND column_name = 'cut_from_audio') THEN
    ALTER TABLE recordings ADD COLUMN cut_from_audio boolean NOT NULL DEFAULT false;
  END IF;
END $$;

-- 전체 음성·조각의 키를 clip_trash에 적고 줄을 지운다.
CREATE OR REPLACE FUNCTION trip_audio_wipe(code text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO clip_trash (object_key)
    SELECT object_key FROM trip_audio WHERE trip_code = code AND object_key IS NOT NULL
    UNION SELECT object_key FROM trip_audio_parts WHERE trip_code = code
  ON CONFLICT DO NOTHING;
  DELETE FROM trip_audio WHERE trip_code = code;
$$;

-- 동의 세대가 오르면 지운다. 세대를 올리는 코드(bumpGeneration)가 같은 트랜잭션에서 여행 문서를 다시 쓸 때 돈다.
CREATE OR REPLACE FUNCTION trip_audio_on_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE((NEW.doc->>'generation')::int, 1) > COALESCE((OLD.doc->>'generation')::int, 1) THEN
    PERFORM trip_audio_wipe(OLD.code);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trip_audio_generation ON trips;
CREATE TRIGGER trip_audio_generation AFTER UPDATE OF doc ON trips FOR EACH ROW EXECUTE FUNCTION trip_audio_on_generation();

-- 여행 줄이 지워지면(지금은 지우는 API가 없음 — 손으로 지우거나 나중에 생길 경로) 전체 음성과 클립의 키를 먼저 적는다.
-- 외래 키의 연쇄 삭제보다 먼저 돌도록 BEFORE. 클립 줄(recordings)은 외래 키가 없어 여기서 함께 지운다.
CREATE OR REPLACE FUNCTION trip_audio_on_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM trip_audio_wipe(OLD.code);
  WITH r AS (DELETE FROM recordings WHERE trip_code = OLD.code RETURNING object_key, deleted_at)
  INSERT INTO clip_trash (object_key) SELECT object_key FROM r WHERE deleted_at IS NULL ON CONFLICT DO NOTHING;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS trip_audio_delete ON trips;
CREATE TRIGGER trip_audio_delete BEFORE DELETE ON trips FOR EACH ROW EXECUTE FUNCTION trip_audio_on_delete();

COMMIT;
