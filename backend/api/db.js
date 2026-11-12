// 같이타의 저장소는 여행과 프로필 둘이다. 주소를 환경 변수로 각각 받고,
// 없으면 DATABASE_URL 하나를 같이 쓴다(로컬 실행과 단일 배포).
// 주소가 같아도 저장소마다 풀을 따로 둔다. 여행 줄을 잠근 연결을 쥔 채
// 프로필 조회가 같은 풀에서 연결을 더 빌리면, 쓰기가 몰릴 때 서로 연결과
// 잠금을 기다리며 서버가 멈춘다. 풀이 모자라면 기다림 없이 5초 안에 오류로 끝낸다.
import pg from "pg";

const pools = new Map();
const poolOf = (store, url) => {
  if (!pools.has(store)) pools.set(store, new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 }));
  return pools.get(store);
};

export const tripsDb = () => poolOf("trips", process.env.TRIPS_DATABASE_URL ?? process.env.DATABASE_URL);
export const profilesDb = () => poolOf("profiles", process.env.PROFILES_DATABASE_URL ?? process.env.DATABASE_URL);
export const endStores = async () => {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
};
