import { createHash, randomBytes, randomUUID } from "node:crypto";
import { tripsDb } from "./db.js";

const fail = (status, error) => { throw { status, error }; };
const hash = (value) => createHash("sha256").update(value).digest();
const lifetime = 5 * 60 * 1000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tokenShape = /^[A-Za-z0-9_-]{43}$/;
const publicParticipant = ({ tokenHash, olderTokenHashes, prefs, ...participant }) => participant;

export async function rideLinks(req, path, { profileOf }) {
  if (path.length > 1) fail(404, "없는 경로");
  const id = path[0];
  if (id && !uuid.test(id)) fail(404, "없는 동승 연결");
  if ((!id && req.method !== "POST") || (id && !["GET", "DELETE"].includes(req.method))) fail(405, id ? "GET, DELETE만 됨" : "POST만 됨");
  const me = (await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함");
  const db = tripsDb();
  if (!id) {
    await db.query("DELETE FROM ride_links WHERE expires_at <= clock_timestamp()");
    const code = randomBytes(32).toString("base64url");
    const participantToken = randomBytes(32).toString("base64url");
    const link = { id: randomUUID(), code, expiresAt: Date.now() + lifetime, participantToken };
    await db.query("INSERT INTO ride_links (id, code_hash, profile_id, participant_token_hash, expires_at) VALUES ($1,$2,$3,$4,$5)",
      [link.id, hash(code), me.id, hash(participantToken).toString("hex"), new Date(link.expiresAt)]);
    return [201, { ...link, qr: JSON.stringify({ type: "gachita-ride", version: 1, code }) }];
  }
  if (req.method === "DELETE") {
    // DELETE와 상환은 같은 행 잠금을 쓴다. 상환된 연결을 지워 참가 결과를 잃지 않게 한다.
    const { rowCount } = await db.query("DELETE FROM ride_links WHERE id=$1 AND profile_id=$2 AND trip_code IS NULL AND expires_at > clock_timestamp()", [id, me.id]);
    if (rowCount) return [204];
    const { rows } = await db.query("SELECT trip_code FROM ride_links WHERE id=$1 AND profile_id=$2 AND expires_at > clock_timestamp()", [id, me.id]);
    if (!rows[0]) fail(404, "없는 동승 연결");
    fail(409, "이미 차에 연결됨");
  }
  const { rows } = await db.query("SELECT id, expires_at, trip_code, participant_id FROM ride_links WHERE id=$1 AND profile_id=$2 AND expires_at > clock_timestamp()", [id, me.id]);
  const link = rows[0] ?? fail(404, "없거나 만료된 동승 연결");
  const view = { id: link.id, status: link.trip_code ? "linked" : "pending", expiresAt: link.expires_at.getTime() };
  if (!link.trip_code) return [200, view];
  const { rows: trips } = await db.query("SELECT doc FROM trips WHERE code=$1 AND created_at > now() - interval '48 hours'", [link.trip_code]);
  const participant = trips[0]?.doc.participants.find((p) => p.id === link.participant_id && p.profileId === me.id);
  if (!participant) fail(404, "연결된 여행을 찾을 수 없음");
  return [200, { ...view, tripCode: link.trip_code, participant: publicParticipant(participant) }];
}

export async function redeemRideLink(req, tripCode, body, { profileById, seats }) {
  if (req.method !== "POST") fail(405, "POST만 됨");
  if (typeof body.code !== "string" || !tokenShape.test(body.code)) fail(400, "code: 동승 연결 QR의 코드");
  if (!seats.includes(body.seat)) fail(400, "seat: 사용할 수 있는 자리");
  const client = await tripsDb().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT *, expires_at > clock_timestamp() AS alive FROM ride_links WHERE code_hash=$1 FOR UPDATE", [hash(body.code)]);
    const link = rows[0];
    if (!link || !link.alive) fail(404, "없거나 만료된 동승 연결");
    if (link.trip_code) fail(409, "이미 사용한 동승 연결");
    const me = (await profileById(link.profile_id)) ?? fail(404, "프로필을 찾을 수 없음");
    const { rows: trips } = await client.query("SELECT doc FROM trips WHERE code=$1 AND created_at > now() - interval '48 hours' FOR UPDATE", [String(tripCode).toUpperCase()]);
    const trip = trips[0]?.doc ?? fail(404, "없거나 보관 기간이 지난 여행");
    if (!["boarding", "parked"].includes(trip.status)) fail(409, "주차 중에만 동승자를 연결할 수 있음");
    if (trip.participants.some((p) => p.profileId === me.id)) fail(409, "이미 참가한 프로필");
    if (trip.participants.some((p) => p.seat === body.seat)) fail(409, "이미 다른 사람이 앉은 자리");
    // 폰에게만 미리 준 토큰의 해시를 참가자에 옮긴다. 차는 동의를 켤 자격을 받지 않는다.
    const participant = { id: randomUUID().slice(0, 8), profileId: me.id, name: me.name, character: me.character,
      seat: body.seat, consent: false, tokenHash: link.participant_token_hash };
    trip.participants.push(participant);
    trip.recording = false;
    trip.version++;
    const updated = await client.query("UPDATE trips SET doc=$2 WHERE code=$1 AND created_at > clock_timestamp()-interval '48 hours'", [trip.code, trip]);
    if (!updated.rowCount) fail(404, "보관 기간이 지난 여행");
    const consumed = await client.query("UPDATE ride_links SET trip_code=$2, participant_id=$3, expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1 AND expires_at > clock_timestamp()", [link.id, trip.code, participant.id]);
    if (!consumed.rowCount) fail(404, "만료된 동승 연결");
    await client.query("COMMIT");
    return [201, { tripCode: trip.code, participant: publicParticipant(participant) }];
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
