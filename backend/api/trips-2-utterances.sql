-- 여행 저장소에 발화 표를 더한다(T39, 2026-11-13). 차량 앱이 받아 적은 발화를 한 줄씩 저장한다.
-- 키는 (여행 코드, 기기, 순번). 같은 순번을 다시 보내도 한 번만 남는다(멱등).
-- ponytail: 부탁·도착 할 일·장면은 발화와 따로 둔다(ADR-0014). 화자 대조(T38)가 profile_id를 채운다.
BEGIN;
SELECT pg_advisory_xact_lock(74621); -- 서버 여러 대가 동시에 시작해도 한 번에 하나만 실행

CREATE TABLE IF NOT EXISTS utterances (
  trip_code text NOT NULL,
  device text NOT NULL,
  seq bigint NOT NULL,                       -- 기기가 매기는 순번. 재전송 범위의 기준
  at bigint NOT NULL,                        -- epoch ms
  text text NOT NULL,
  seat_area text,                            -- Pleos SeatArea와 같은 이름(좌석 구역, T37). 모르면 비어 있음
  profile_id uuid,                           -- 화자 대조 결과. 아직 못 붙이면 비어 있음(T38)
  confidence double precision,               -- 받아쓰기 확신도(제공자가 주면)
  lat double precision,
  lng double precision,
  generation int NOT NULL DEFAULT 1,         -- 발화를 만들 때의 동의 세대(ADR-0007)
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_code, device, seq)
);
CREATE INDEX IF NOT EXISTS utterances_trip_at ON utterances (trip_code, at);
CREATE INDEX IF NOT EXISTS utterances_profile ON utterances (profile_id);

-- 기기마다 빠짐없이 받은 마지막 순번. 발화 줄이 지워져도(동의 철회·글 지우기) 뒤로 가지 않게 따로 둔다.
CREATE TABLE IF NOT EXISTS utterance_acks (
  trip_code text NOT NULL,
  device text NOT NULL,
  last_seq bigint NOT NULL,
  PRIMARY KEY (trip_code, device)
);

COMMIT;
