-- 여행 저장소에 참가자 목소리 값을 더한다(T38, 2026-11-14). 차의 가족은 손님 참가자(프로필 없음)라
-- 프로필 등록값(voice_prints)으로는 화자를 붙이지 못한다. 여행마다 참가자의 대조용 값을 두고,
-- 대조로 찾은 참가자를 발화 줄에 적는다(ADR-0019).
-- ponytail: 등록 음성 원본은 어디에도 저장하지 않는다. 값은 그 참가자의 동의가 꺼지거나 여행이 지워질 때(48시간) 함께 지운다.
BEGIN;
SELECT pg_advisory_xact_lock(74626); -- 서버 여러 대가 동시에 시작해도 한 번에 하나만 실행

CREATE TABLE IF NOT EXISTS trip_voice_prints (
  trip_code text NOT NULL,
  participant_id text NOT NULL,
  vector double precision[] NOT NULL,         -- 대조용 값(L2 정규화). 임베더는 providers/voice.js
  seconds real NOT NULL,                      -- 등록 음성 길이
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_code, participant_id)
);

-- 대조로 찾은 참가자. 손님도 화자가 붙는다(profile_id는 프로필 참가자일 때만).
ALTER TABLE utterances ADD COLUMN IF NOT EXISTS participant_id text;

COMMIT;
