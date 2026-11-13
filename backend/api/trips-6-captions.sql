-- T80: 원문과 자동 재전사는 그대로 두고 사람이 고친 자막을 같은 보관 기간의 별도 칸에 둔다.
BEGIN;
SELECT pg_advisory_xact_lock(74627);
ALTER TABLE utterances ADD COLUMN IF NOT EXISTS edited_text text;
ALTER TABLE utterances ADD COLUMN IF NOT EXISTS edit_version integer NOT NULL DEFAULT 0;
ALTER TABLE utterances ADD COLUMN IF NOT EXISTS edited_by text;
ALTER TABLE utterances ADD COLUMN IF NOT EXISTS edited_at timestamptz;
-- 구 이미지와 함께 돌거나 되돌려도 옛 DELETE가 원문을 비우면 새 수정 칸까지 지운다.
CREATE OR REPLACE FUNCTION erase_caption_with_utterance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.text = '' THEN
    NEW.edited_text := NULL;
    NEW.edit_version := 0;
    NEW.edited_by := NULL;
    NEW.edited_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS erase_caption ON utterances;
CREATE TRIGGER erase_caption BEFORE UPDATE OF text ON utterances
  FOR EACH ROW EXECUTE FUNCTION erase_caption_with_utterance();
COMMIT;
