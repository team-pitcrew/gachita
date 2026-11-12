// 같이타의 저장소는 여행과 프로필 둘이다. 주소를 환경 변수로 각각 받고,
// 없으면 DATABASE_URL 하나를 같이 쓴다(로컬 실행과 단일 배포).
// 같은 주소를 가리키면 풀도 하나를 같이 쓴다.
import pg from "pg";

const pools = new Map();
const poolOf = (url) => {
  if (!pools.has(url)) pools.set(url, new pg.Pool({ connectionString: url }));
  return pools.get(url);
};

export const tripsDb = () => poolOf(process.env.TRIPS_DATABASE_URL ?? process.env.DATABASE_URL);
export const profilesDb = () => poolOf(process.env.PROFILES_DATABASE_URL ?? process.env.DATABASE_URL);
export const endStores = async () => {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
};
