// 같이타의 저장소는 여행과 프로필 둘이다. 주소를 환경 변수로 각각 받고,
// 없으면 DATABASE_URL 하나를 같이 쓴다(로컬 실행과 단일 배포).
// 주소가 같아도 저장소마다 풀을 따로 둔다. 여행 줄을 잠근 연결을 쥔 채
// 프로필 조회가 같은 풀에서 연결을 더 빌리면, 쓰기가 몰릴 때 서로 연결과
// 잠금을 기다리며 서버가 멈춘다. 풀이 모자라면 기다림 없이 5초 안에 오류로 끝낸다.
import pg from "pg";
import { errFields, log } from "./log.js";

const pools = new Map();
const poolOf = (store, url) => {
  if (!pools.has(store)) {
    const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
    // 연결이 끊기면(Postgres 재시작·장애 조치·통신 끊김) 'error'가 나는데, 처리기가 없으면 프로세스가 죽는다.
    // 쉬던 연결은 풀이, 빌려 간 연결(트랜잭션 중)은 그 연결이 낸다 — 둘 다 기록만 남긴다. 끊긴 연결은 풀이 버리고
    // 다음 요청에서 새로 맺는다(node-postgres의 Pool·Client 'error' 안내).
    const lost = (e) => log("warn", "db_connection_lost", { store, err: errFields(e) });
    pool.on("error", lost);
    pool.on("connect", (client) => client.on("error", lost));
    pools.set(store, pool);
  }
  return pools.get(store);
};

export const tripsDb = () => poolOf("trips", process.env.TRIPS_DATABASE_URL ?? process.env.DATABASE_URL);
export const profilesDb = () => poolOf("profiles", process.env.PROFILES_DATABASE_URL ?? process.env.DATABASE_URL);
export const endStores = async () => {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
};
