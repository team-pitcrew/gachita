-- 화자가 어떻게 붙었는지와 그 확신도(ADR-0023, 2026-11-14). 차가 차 안에서 대조해 발화와 함께 올린 것(device-voice),
-- 서버가 소리를 받아 대조한 것(server-voice)을 가린다. 사람이 고친 줄은 speaker_by_hand이고 이 두 칸은 비운다.
BEGIN;
SELECT pg_advisory_xact_lock(74637);
ALTER TABLE utterances ADD COLUMN IF NOT EXISTS speaker_confidence real;
ALTER TABLE utterances ADD COLUMN IF NOT EXISTS speaker_method text;
COMMIT;
