-- 여행 참가자 목소리의 둘째 값(강한 화자 값, 2026-11-15). profiles-9-voice-strong.sql과 같은 뜻.
-- 1차 값과 같은 줄이라 그 참가자의 동의가 꺼지거나 여행이 지워지면 함께 지워진다.
BEGIN;
SELECT pg_advisory_xact_lock(74653);
ALTER TABLE trip_voice_prints ADD COLUMN IF NOT EXISTS strong double precision[];
ALTER TABLE trip_voice_prints ADD COLUMN IF NOT EXISTS strong_seconds real;
COMMIT;
