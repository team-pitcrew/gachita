-- 가족·동승 그룹을 새 모양으로 되살린다(T133, 2026-11-14). 옛 표(profiles-4-groups.sql)를 그대로 쓴다 —
-- 이전 이미지로 되돌려도 옛 코드의 프로필 지우기가 같은 표를 치운다.
-- 역할은 저장하지 않는다: 대표는 groups.owner_id, 아이는 managed_by가 있는 프로필, 나머지는 성인.
BEGIN;
SELECT pg_advisory_xact_lock(74642); -- 서버 여러 대가 동시에 시작해도 한 번에 하나만 실행

-- 그룹 안의 저장된 자리(Pleos SeatArea 이름). 자리 없는 구성원은 비어 있다.
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS seat text;
-- 같은 그룹에서 같은 자리는 하나. 비어 있는 자리(NULL)는 겹쳐도 된다. 검사를 트랜잭션 끝으로 미뤄 맞바꾸기를 한 번에 한다.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'group_members_seat' AND conrelid = 'group_members'::regclass) THEN
    ALTER TABLE group_members ADD CONSTRAINT group_members_seat UNIQUE (group_id, seat) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS group_members_profile ON group_members (profile_id); -- 내 그룹 목록

COMMIT;
