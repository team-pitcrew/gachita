-- 공급자가 실제로 반환한 발화 끝 시각과 요청 범위의 익명 화자입니다. 참가자 신원과 별개입니다.
BEGIN;
SELECT pg_advisory_xact_lock(74636);
ALTER TABLE utterances ADD COLUMN IF NOT EXISTS end_at bigint;
ALTER TABLE utterances ADD COLUMN IF NOT EXISTS speaker_label text;
ALTER TABLE utterances ADD COLUMN IF NOT EXISTS speaker_scope uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='utterances_segment_bounds' AND conrelid='utterances'::regclass) THEN
    ALTER TABLE utterances ADD CONSTRAINT utterances_segment_bounds CHECK (end_at IS NULL OR (end_at > at AND end_at <= at+10000));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='utterances_anonymous_speaker' AND conrelid='utterances'::regclass) THEN
    ALTER TABLE utterances ADD CONSTRAINT utterances_anonymous_speaker CHECK (
      (speaker_label IS NULL AND speaker_scope IS NULL) OR
      (speaker_label IS NOT NULL AND speaker_label ~ '^spk:[0-9]{1,4}$' AND speaker_scope IS NOT NULL)
    );
  END IF;
END $$;
COMMIT;
