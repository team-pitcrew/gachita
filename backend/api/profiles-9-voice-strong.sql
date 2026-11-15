-- 목소리의 둘째 값(강한 화자 값, 2026-11-15). 기기가 학습된 화자 모델(wespeaker resnet34, 256차원)로 계산해 올린 값을
-- 1차 값(vector)과 같은 줄에 둔다 — 프로필·목소리를 지우면 함께 지워진다. 서버는 계산하지 않는다(ADR-0023).
BEGIN;
SELECT pg_advisory_xact_lock(74652); -- 서버 여러 대가 동시에 시작해도 한 번에 하나만 실행
ALTER TABLE voice_prints ADD COLUMN IF NOT EXISTS strong double precision[];
ALTER TABLE voice_prints ADD COLUMN IF NOT EXISTS strong_seconds real;
COMMIT;
