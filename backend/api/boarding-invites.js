import { createHash, randomBytes, randomUUID } from "node:crypto";
import { tripsDb } from "./db.js";
import { withActiveProfile } from "./profile-lifecycle.js";
import { accountConsents } from "./accounts.js";

const fail = (status, error) => { throw { status, error }; };
const hash = (value) => createHash("sha256").update(value).digest();
const tokenShape = /^[A-Za-z0-9_-]{43}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const publicParticipant = ({ tokenHash, olderTokenHashes, prefs, ...participant }) => participant;
const parked = (trip) => {
  if (!["boarding", "parked"].includes(trip.status)) fail(409, "주차 중에만 동승자를 초대하고 참여할 수 있어요");
};
const active = (invite, trip) => {
  if (!invite || !trip) fail(404, "없는 동승 초대");
  if (!invite.alive || invite.revoked_at || !trip.participants.some((p) => p.id === invite.issuer_id && p.seat === "ROW_1_LEFT"))
    fail(410, "종료된 동승 초대예요. 차에서 새 QR을 열어 주세요");
  parked(trip);
};

// 차가 발급·폐기합니다. 여행 잠금을 먼저 잡아 재발급·가입·좌석 변경이 서로를 지나치지 않게 합니다.
export async function tripBoardingInvites(req, tripCode, id, { withTrip, participantOf }) {
  if ((!id && req.method !== "POST") || (id && req.method !== "DELETE")) fail(405, id ? "DELETE만 됨" : "POST만 됨");
  if (id && !uuid.test(id)) fail(404, "없는 동승 초대");
  return withTrip(tripCode, true, async (trip, client) => {
    const caller = participantOf(req, trip);
    if (id) {
      const { rows } = await client.query("SELECT issuer_id FROM boarding_invites WHERE id=$1 AND trip_code=$2", [id, trip.code]);
      if (!rows[0]) fail(404, "없는 동승 초대");
      if (rows[0].issuer_id !== caller.id) fail(403, "초대를 연 참가자만 닫을 수 있어요");
      await client.query("UPDATE boarding_invites SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1", [id]);
      return [204];
    }
    if (caller.seat !== "ROW_1_LEFT") fail(403, "운전석 참가자만 차량 초대를 열 수 있어요");
    parked(trip);
    const code = randomBytes(32).toString("base64url");
    const inviteId = randomUUID();
    await client.query("UPDATE boarding_invites SET revoked_at=clock_timestamp() WHERE trip_code=$1 AND revoked_at IS NULL", [trip.code]);
    const { rows } = await client.query(
      "INSERT INTO boarding_invites (id,code_hash,trip_code,issuer_id,expires_at) VALUES ($1,$2,$3,$4,clock_timestamp()+interval '5 minutes') RETURNING expires_at",
      [inviteId, hash(code), trip.code, caller.id]
    );
    return [201, { id: inviteId, url: `/?join=${code}`, expiresAt: rows[0].expires_at.getTime() }];
  });
}

// 폰이 공개 초대를 읽고 본인 프로필로 참가합니다. QR에는 초대 코드만 있고 참가자 토큰은 응답에서 폰에만 줍니다.
export async function boardingInvites(req, path, body, { profileOf, withTrip, seats }) {
  const [code, leaf, ...rest] = path;
  if (!tokenShape.test(code ?? "") || rest.length || (leaf && leaf !== "participants")) fail(404, "없는 동승 초대");
  if ((!leaf && req.method !== "GET") || (leaf && req.method !== "POST")) fail(405, leaf ? "POST만 됨" : "GET만 됨");
  const read = async (client = tripsDb()) => (await client.query(
    "SELECT i.*, i.expires_at > clock_timestamp() AS alive, t.doc FROM boarding_invites i JOIN trips t ON t.code=i.trip_code WHERE i.code_hash=$1", [hash(code)]
  )).rows[0];
  if (!leaf) {
    const invite = await read();
    active(invite, invite?.doc);
    return [200, { title: invite.doc.title, seats: seats.filter((seat) => !invite.doc.participants.some((p) => p.seat === seat)), expiresAt: invite.expires_at.getTime() }];
  }
  const profile = (await profileOf(req)) ?? fail(401, "본인 프로필로 로그인한 뒤 참여해 주세요");
  if (!seats.includes(body.seat)) fail(400, "seat: 사용할 수 있는 자리");
  // 동의는 입력으로 받지 않습니다(대리 동의를 넘기지 못하게). 본인이 계정에서 지금 문구 판에 동의해 두었으면 켠 채로,
  // 아니면 꺼진 채로 들어가 본인 참가자 토큰으로 켭니다(T128). 프로필의 기본값(consentDefault)은 여기서 쓰지 않습니다.
  if (Object.keys(body).some((key) => key !== "seat")) fail(400, "참가 요청에는 seat만 넣어 주세요");
  const candidate = await read();
  active(candidate, candidate?.doc);
  // 기존 일반 참가와 같은 프로필 → 여행 잠금 순서를 지켜 프로필 삭제와의 경합을 막습니다.
  return withActiveProfile(profile.id, db => profileOf(req, db), (me, client) => withTrip(candidate.trip_code, true, async (trip, db) => {
    const invite = await read(db);
    active(invite, trip); // 기다리는 동안 만료·폐기·주행·종료·발급자 변경이 생겼는지 다시 확인합니다.
    const again = trip.participants.find((p) => p.profileId === me.id);
    if (!again && trip.participants.some((p) => p.seat === body.seat)) fail(409, "다른 사람이 먼저 선택한 자리예요");
    const token = randomBytes(32).toString("base64url");
    const participant = again ?? { id: randomUUID().slice(0, 8), profileId: me.id, name: me.name, character: me.character, seat: body.seat, consent: accountConsents(me) };
    if (again) participant.olderTokenHashes = [...(participant.olderTokenHashes ?? []), participant.tokenHash].slice(-4);
    else {
      trip.participants.push(participant);
      trip.recording = false;
    }
    participant.tokenHash = hash(token).toString("hex");
    trip.version++;
    return [again ? 200 : 201, { tripCode: trip.code, participant: publicParticipant(participant), token }];
  }, client));
}
