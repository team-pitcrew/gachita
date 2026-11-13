-- 프로필 저장소에 장면 앨범 표를 더한다(T39, 2026-11-13). 사람이 장면으로 확정하면
-- 그 복사본을 고른 사람의 프로필에 남긴다(참조가 아니라 복사 — 여행이 닫혀도 남는다, ADR-0014).
-- ponytail: 기준 문서의 '선택한 장면만 개인 앨범에'를 이 표로 지킨다. 발화는 48시간 뒤 지운다.
BEGIN;
SELECT pg_advisory_xact_lock(74622); -- 서버 여러 대가 동시에 시작해도 한 번에 하나만 실행

CREATE TABLE IF NOT EXISTS profile_moments (
  id text NOT NULL,                          -- 여행의 moments와 같은 id(같은 장면을 다시 복사하지 않는다). 여행 안에서만 유일
  profile_id uuid NOT NULL,
  trip_code text NOT NULL,
  at bigint NOT NULL,                        -- epoch ms
  lat double precision,                      -- 위치 없는 장면은 둘 다 비어 있다(ADR-0007)
  lng double precision,
  label text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, id)
);
CREATE INDEX IF NOT EXISTS profile_moments_profile ON profile_moments (profile_id, at DESC);

COMMIT;
