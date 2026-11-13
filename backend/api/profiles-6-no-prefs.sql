-- 좌석·공조 선호를 걷어낸다(T68, 2026-11-14). 11/13 계획에서 좌석·공조 적용이 빠졌다.
-- 서버는 prefs 칸을 읽지도 쓰지도 않는다. 칸은 기본값만 주고 남긴다: 배포하는 동안 함께 도는 옛 파드
-- (replicas 2, maxSurge 1)와 이전 이미지로 되돌린 서버가 이 칸을 읽는다. 칸 지우기는 한 번 내보낸 뒤
-- 옛 칸 token_hash와 함께 한다.
BEGIN;
SELECT pg_advisory_xact_lock(74625); -- 서버 여러 대가 동시에 시작해도 한 번에 하나만 실행

ALTER TABLE profiles ALTER COLUMN prefs SET DEFAULT '{}';

COMMIT;
