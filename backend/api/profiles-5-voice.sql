-- 프로필 저장소에 목소리 대조용 값을 더한다(T38, 2026-11-13).
-- ponytail: 등록 음성 원본은 어디에도 저장하지 않는다 — 대조용 벡터만 남는다(생체 정보 최소 보관, ADR-0019).
BEGIN;
SELECT pg_advisory_xact_lock(74624); -- 서버 여러 대가 동시에 시작해도 한 번에 하나만 실행

CREATE TABLE IF NOT EXISTS voice_prints (
  profile_id uuid PRIMARY KEY,
  vector double precision[] NOT NULL,         -- 대조용 값(L2 정규화). 임베더는 providers/voice.js
  seconds real NOT NULL,                      -- 등록 음성 길이(등록 길이별 정확도 비교용)
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
