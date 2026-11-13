-- 프로필 저장소에 기기별 토큰·그룹·초대를 더한다(T45, 2026-11-13).
-- ponytail: 한 프로필을 차량과 폰에서 함께 쓰게 토큰을 기기마다 둔다(ADR-0009).
--           기존 프로필의 token_hash는 첫 기기 토큰으로 옮기고 칸은 지운다(한 번만 돈다).
BEGIN;
SELECT pg_advisory_xact_lock(74623); -- 서버 여러 대가 동시에 시작해도 한 번에 하나만 실행

CREATE TABLE IF NOT EXISTS tokens (
  token_hash bytea PRIMARY KEY,              -- 토큰의 SHA-256. 토큰 자체는 저장하지 않는다
  profile_id uuid NOT NULL,
  device text NOT NULL DEFAULT '',           -- 기기 이름(차량, 폰…). 표시용
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tokens_profile ON tokens (profile_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'token_hash') THEN
    INSERT INTO tokens (token_hash, profile_id) SELECT token_hash, id FROM profiles ON CONFLICT DO NOTHING;
    ALTER TABLE profiles DROP COLUMN token_hash;
  END IF;
END $$;

-- 가족·동승자 그룹과 QR 초대(ADR-0009). 계정 없는 구성원(아이)은 대표가 만든 프로필로 둔다.
CREATE TABLE IF NOT EXISTS groups (
  id text PRIMARY KEY,
  kind text NOT NULL,                        -- family | crew
  name text NOT NULL DEFAULT '',
  owner_id uuid NOT NULL,                    -- 대표 프로필
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id text NOT NULL,
  profile_id uuid NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, profile_id)
);
CREATE TABLE IF NOT EXISTS invites (
  code text PRIMARY KEY,                     -- 초대 주소에 담기는 코드(/j/<코드>)
  group_id text NOT NULL,
  max_uses int NOT NULL DEFAULT 5,           -- 0은 제한 없음
  uses int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invites_group ON invites (group_id);

-- 프로필 사진과 캐릭터. 사진은 이 저장소에 바이트로 두고(형식·크기는 서버가 검사),
-- 캐릭터는 화면 문서(T46)에서 정할 목록이 확정되면 고정한다.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS photo bytea;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS photo_type text NOT NULL DEFAULT '';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS character text NOT NULL DEFAULT '';

COMMIT;
