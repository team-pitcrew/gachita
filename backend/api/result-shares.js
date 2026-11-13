import { randomUUID } from "node:crypto";
import { profilesDb, tripsDb } from "./db.js";

const fail = (status, error) => { throw { status, error }; };
const uuid = (id) => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const person = (p) => ({ name: p.name, character: p.character });

// 여행 잠금을 가진 연결로 부른다. 녹음 동의와 별개로, 이 요청이 내용·대상을 확인한 공유 실행이다.
export async function createShare(client, trip, caller, b) {
  if (!caller.consent || !caller.profileId) fail(403, "프로필로 참가하고 기록에 동의해야 공유할 수 있음");
  if (b.generation !== (trip.generation ?? 1)) fail(409, "동의 상태가 바뀌었어요. 기록을 다시 확인해 주세요");
  if (!Array.isArray(b.recipientIds) || !b.recipientIds.length || b.recipientIds.length > 4 || new Set(b.recipientIds).size !== b.recipientIds.length) fail(400, "받는 동승자 1~4명을 중복 없이 골라 주세요");
  const recipients = b.recipientIds.map((id) => trip.participants.find((p) => p.id === id));
  if (recipients.some((p) => !p?.profileId || !p.consent || p.profileId === caller.profileId)) fail(403, "같은 여행에서 동의한 다른 프로필 참가자만 받을 수 있음");
  if (typeof b.includeLocation !== "boolean") fail(400, "위치 포함 여부를 선택해 주세요");
  if (typeof b.caption !== "string" || !b.caption.isWellFormed() || b.caption.includes("\0") || b.caption.trim().length > 500) fail(400, "문구는 500자 이내로 확인해 주세요");
  if (typeof b.momentId !== "string" || b.momentId.length > 40) fail(400, "공유할 장면을 골라 주세요");
  const ids = [caller.profileId, ...recipients.map((p) => p.profileId)];
  const people = await profilesDb().query("SELECT id, managed_by FROM profiles WHERE id = ANY($1::uuid[])", [ids]);
  if (new Set(people.rows.map((p) => p.id)).size !== new Set(ids).size) fail(404, "삭제된 참가자 프로필이 있어요");
  if (people.rows.some((p) => p.managed_by)) fail(403, "자기 프로필로 직접 참가한 사람끼리만 공유할 수 있어요");
  const { rows: albums } = await profilesDb().query("SELECT at, label, lat, lng FROM profile_moments WHERE profile_id = $1 AND id = $2 AND trip_code = $3", [caller.profileId, b.momentId, trip.code]);
  const album = albums[0] ?? fail(404, "내 앨범에 없는 장면");
  if (b.includeLocation && (album.lat === null || album.lng === null)) fail(400, "이 장면에는 위치 정보가 없어요");
  const payload = { at: Number(album.at), label: album.label, caption: b.caption.trim(), ...(b.includeLocation ? { lat: album.lat, lng: album.lng } : {}) };
  const { rows: counts } = await client.query("SELECT count(*)::int AS n FROM result_shares WHERE trip_code = $1", [trip.code]);
  if (counts[0].n >= 500) fail(409, "이 여행의 공유가 너무 많아요. 이전 공유를 회수해 주세요");
  const id = randomUUID();
  // 잠금을 기다리다 48시간을 넘긴 경우도 쓰지 않는다. 원음·토큰·여행 코드를 payload에 넣지 않는다.
  const { rows } = await client.query(
    `INSERT INTO result_shares (id, trip_code, moment_id, sender_id, recipient_ids, generation, payload, expires_at)
     SELECT $1, code, $3, $4, $5, $6, $7, created_at + interval '48 hours' FROM trips
     WHERE code = $2 AND created_at > clock_timestamp() - interval '48 hours'
     RETURNING created_at, expires_at`,
    [id, trip.code, b.momentId, caller.profileId, recipients.map((p) => p.profileId), trip.generation ?? 1, payload]
  );
  if (!rows[0]) fail(404, "보관 기간이 지난 여행");
  return [201, { id, ...payload, createdAt: rows[0].created_at.getTime(), expiresAt: rows[0].expires_at.getTime(), recipientCount: recipients.length }];
}

export async function sharedResults(me, method, id) {
  if (id) {
    if (method !== "DELETE") fail(405, "DELETE만 됨");
    if (!uuid(id)) fail(404, "없는 공유");
    const { rowCount } = await tripsDb().query("DELETE FROM result_shares WHERE id = $1 AND sender_id = $2", [id, me.id]);
    if (!rowCount) fail(404, "보낸 공유가 아니거나 이미 회수했어요");
    return [204];
  }
  if (method !== "GET") fail(405, "GET만 됨");
  const { rows } = await tripsDb().query(
    `SELECT s.*, t.doc FROM result_shares s JOIN trips t ON t.code = s.trip_code
     WHERE (s.sender_id = $1 OR $1 = ANY(s.recipient_ids)) AND s.expires_at > now()
       AND t.created_at > now() - interval '48 hours' AND s.generation = COALESCE((t.doc->>'generation')::int, 1)
     ORDER BY s.created_at DESC LIMIT 200`, [me.id]
  );
  if (!rows.length) return [200, { items: [] }];
  const ids = [...new Set(rows.flatMap((r) => [r.sender_id, ...r.recipient_ids]))];
  const { rows: people } = await profilesDb().query("SELECT id, name, character FROM profiles WHERE id = ANY($1::uuid[]) AND managed_by IS NULL", [ids]);
  const byId = new Map(people.map((p) => [p.id, p]));
  const { rows: albums } = await profilesDb().query("SELECT id, profile_id, trip_code FROM profile_moments WHERE profile_id = ANY($1::uuid[]) AND id = ANY($2::text[])", [rows.map((r) => r.sender_id), rows.map((r) => r.moment_id)]);
  const sources = new Set(albums.map((r) => `${r.profile_id}/${r.trip_code}/${r.id}`));
  const items = [];
  for (const r of rows) {
    const active = (id) => byId.has(id) && r.doc.participants.some((p) => p.profileId === id && p.consent);
    if (!sources.has(`${r.sender_id}/${r.trip_code}/${r.moment_id}`) || !active(r.sender_id) || !active(me.id)) continue;
    const recipients = r.recipient_ids.filter(active);
    if (!recipients.length || (me.id !== r.sender_id && !recipients.includes(me.id))) continue;
    items.push({ id: r.id, direction: me.id === r.sender_id ? "sent" : "received", sender: person(byId.get(r.sender_id)),
      ...(me.id === r.sender_id ? { recipients: recipients.map((id) => person(byId.get(id))) } : {}),
      ...r.payload, createdAt: r.created_at.getTime(), expiresAt: r.expires_at.getTime() });
  }
  return [200, { items }];
}
