-- 프로필 사진을 S3로 옮긴다(T178, ADR-0027). 버킷이 있는 환경은 사진을 `profiles/{프로필 id}/photo/{내용 해시 16자}.{확장자}`에
-- 두고 여기에는 키와 형식(photo_type)만 남긴다. 버킷이 없는 환경(로컬)은 지금처럼 photo(bytea)에 둔다.
-- 옛 bytea는 profile-photos.js가 옮긴다(한 번 실행, 다시 돌려도 안전). photo 칸은 지우지 않는다 — 이전 이미지로 되돌려도 읽히게.
BEGIN;
SELECT pg_advisory_xact_lock(74653); -- 서버 여러 대가 동시에 시작해도 한 번에 하나만 실행
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS photo_key text;
COMMIT;
