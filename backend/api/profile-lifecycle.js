import { createHash } from "node:crypto";
import { profilesDb, tripsDb } from "./db.js";

const missing = () => { throw { status: 404, error: "프로필을 찾을 수 없음" }; };

// T90: 시간 만료가 없어도 명시적 삭제와 참가가 서로를 지나치지 않게 합니다.
// 잠금 순서: 프로필별 여행 DB advisory → 프로필 DB 행 → 여행 DB 행입니다.
// 여러 프로필은 advisory 키 순서로 잠급니다. 콜백은 이 여행 DB 연결을 재사용합니다.
async function withProfileLocks(ids, fn) {
  const keys = [...new Set(ids.map(id => createHash("sha256").update(`gachita-profile:${id}`).digest().readBigInt64BE().toString()))]
    .sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
  const client = await tripsDb().connect();
  const locked = [];
  let broken = false;
  try {
    for (const key of keys) {
      await client.query("SELECT pg_advisory_lock($1::bigint)", [key]);
      locked.push(key);
    }
    return await fn(client);
  } catch (error) {
    broken = true;
    throw error;
  } finally {
    // 세션 잠금이 풀리지 않은 연결을 풀에 돌려보내지 않습니다.
    for (const key of locked.reverse()) {
      try { await client.query("SELECT pg_advisory_unlock($1::bigint)", [key]); }
      catch { broken = true; }
    }
    client.release(broken);
  }
}

async function withProfileTransaction(fn) {
  const db = await profilesDb().connect();
  try {
    await db.query("BEGIN");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { db.release(); }
}

export async function withActiveProfile(id, readProfile, fn) {
  return withProfileLocks([id], client => withProfileTransaction(async db => {
    // 여행 DB 연결이 끊겨 삭제 잠금이 먼저 풀렸더라도, 프로필 DB의 진행 중
    // DELETE/COMMIT가 끝난 뒤 생존 여부를 확인합니다. 읽은 행은 참가 커밋까지 유지합니다.
    if (!(await db.query("SELECT id FROM profiles WHERE id=$1 FOR SHARE", [id])).rowCount) missing();
    const profile = (await readProfile(db)) ?? missing();
    if (profile.id !== id) missing();
    // 실패·중단된 삭제의 표식만 회수합니다. 실제 삭제된 ID는 위 검사에서 거절됩니다.
    await client.query("DELETE FROM profile_deletions WHERE profile_id=$1", [id]);
    return fn(profile, client);
  }));
}

export async function withDeletingProfiles(ids, revoke, remove) {
  const all = [...new Set(ids)].sort();
  return withProfileLocks(all, client => withProfileTransaction(async db => {
    await db.query("SELECT id FROM profiles WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [all]);
    // 표식은 여행 철회 트랜잭션과 별도로 먼저 커밋합니다. 두 DB 사이에는 분산
    // 트랜잭션이 없으므로 여행 철회가 완료된 다음에만 프로필 삭제를 커밋합니다.
    await client.query("INSERT INTO profile_deletions (profile_id) SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING", [all]);
    await revoke(client);
    return remove(db);
  }));
}
