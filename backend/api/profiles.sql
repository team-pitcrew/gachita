-- 프로필 저장소의 표. 서버가 시작할 때마다 실행되므로 여러 번 돌려도 같은 결과여야 한다.
-- ponytail: 표를 고칠 일이 생기면 번호 붙은 마이그레이션 파일로 옮긴다.
BEGIN;
SELECT pg_advisory_xact_lock(74619); -- 서버 여러 대가 동시에 시작해도 한 번에 하나만 실행

CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE,          -- 토큰의 SHA-256. 토큰 자체는 저장하지 않는다
  name text NOT NULL,
  prefs jsonb NOT NULL,                      -- { driver, passenger, rear } 각각 { tempC, heat, vent }
  consent_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
