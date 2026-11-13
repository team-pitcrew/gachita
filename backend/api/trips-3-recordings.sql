-- 여행 저장소에 녹음 클립 표를 더한다(T76, 2026-11-14). 소리는 클립 버킷(CLIPS_BUCKET)에 두고 여기에는 정보만 둔다.
-- 키는 (여행 코드, 장면 id) — 장면 하나에 클립 하나. 버킷의 키(object_key)는 '<여행 코드>/<장면 id>-<임의>.wav'로
-- 올릴 때마다 달라, 같은 장면을 동시에 두 번 올려도 진 쪽이 자기 것만 지운다.
-- 사람이 지운 클립은 줄을 남기고 deleted_at만 채운다: 차가 늦게 다시 올려도 되살아나지 않게(voice.md).
-- 동의 철회와 48시간 치우기는 줄째 지운다(세대 확인이 늦은 올리기를 막는다).
BEGIN;
SELECT pg_advisory_xact_lock(74622); -- 서버 여러 대가 동시에 시작해도 한 번에 하나만 실행

CREATE TABLE IF NOT EXISTS recordings (
  trip_code text NOT NULL,
  moment_id text NOT NULL,
  generation int NOT NULL,                   -- 녹음할 때의 동의 세대(ADR-0007)
  participant_id text NOT NULL,              -- 올린 참가자
  object_key text NOT NULL,
  start_at bigint NOT NULL,                  -- 클립 첫 표본의 시각(epoch ms, 차가 자른 구간의 시작). 숏폼 자막을 맞춘다(T43)
  bytes int NOT NULL,
  seconds double precision NOT NULL,
  deleted_at timestamptz,                    -- 사람이 지움. 소리는 버킷에서 이미 지웠다
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_code, moment_id)
);

COMMIT;
