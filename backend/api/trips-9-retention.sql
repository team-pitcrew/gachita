-- T90: 시간 경과에 따른 여행·공유·영상 만료를 제거합니다. 원본과 동의 세대는 보존합니다.
BEGIN;
SELECT pg_advisory_xact_lock(74629);
-- 명시적 프로필 삭제는 여행 정리보다 먼저 기록합니다. 실패한 삭제는 살아 있는
-- 프로필 행 잠금 아래에서만 회수하며, 삭제된 ID의 재참가는 허용하지 않습니다.
CREATE TABLE IF NOT EXISTS profile_deletions (
  profile_id uuid PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE result_shares ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE short_generations ALTER COLUMN expires_at DROP NOT NULL;
-- 이전 정책으로 만든 기한만 바꿉니다. 명시적 삭제·취소와 별도 유한 기한은 변경하지 않습니다.
UPDATE result_shares s SET expires_at = NULL FROM trips t
 WHERE s.trip_code=t.code AND s.expires_at=t.created_at + interval '48 hours';
UPDATE short_generations s SET expires_at = NULL FROM trips t
 WHERE s.trip_code=t.code AND s.expires_at=to_timestamp((t.doc->>'createdAt')::double precision/1000) + interval '48 hours';
COMMIT;
