-- 발화에 재전사한 글을 더한다(T75, 2026-11-14). 사람이 고른 장면 클립의 소리로 다시 받아 적은 글이다.
-- 원문(text, Pleos STT)은 그대로 두고 옆에 둔다. 숏폼 자막은 이 글을, 없으면 원문을 쓴다.
-- 자기 글 지우기·동의 철회·48시간 치우기는 원문과 함께 지운다(같은 줄).
BEGIN;
SELECT pg_advisory_xact_lock(74626); -- 서버 여러 대가 동시에 시작해도 한 번에 하나만 실행

ALTER TABLE utterances ADD COLUMN IF NOT EXISTS asr_text text;
-- 클립마다 재전사가 '여기까지 봤다'(그 실행이 시작한 시각). 그 뒤에 들어온 줄만 다음에 보낸다.
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS asr_done_at timestamptz;

COMMIT;
