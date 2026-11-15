// 가족·동승 그룹(T133, docs/api/groups.md). 옛 표(groups, group_members, invites, profiles.managed_by)를 다시 쓴다.
// 역할은 저장하지 않고 정한다: 대표 = groups.owner_id, 아이 = managed_by가 있는 프로필(토큰 없음), 나머지 = 성인.
// 그룹 경로는 구성원만 — 구성원이 아니면 없는 그룹과 같은 404로 답한다(있는 id인지 알려 주지 않게).
import { randomInt, randomUUID } from "node:crypto";
import { profilesDb } from "./db.js";
import { DIMS } from "./providers/voice.js";
import { accountConsents, CONSENT_VERSION } from "./accounts.js";

const fail = (status, error) => {
  throw { status, error };
};
const KINDS = ["family", "guest"];
const PREFIX = { family: "FAMILY", guest: "TRIP" };
const CODE = /^(FAMILY|TRIP)-[0-9]{4}$/;
// 초대의 앱 주소(같은 출처의 상대 주소). QR은 이 주소를 담고, 코드 입력·QR·링크는 모두 같은 POST /group-invites/{code}로 들어간다.
const inviteOf = (code, expiresAt) => ({ code, expiresAt, url: `/?group=${code}` });
const GROUP_ID = /^[A-Za-z0-9-]{1,64}$/; // 새 그룹은 UUID, 옛 그룹은 8자
const MAX_MEMBERS = 10; // 그룹 하나에(아이 포함). 자리는 다섯이고 나머지는 자리 없이 둔다
const MAX_GROUPS = 20; // 한 사람이 속한 그룹
// 초대·QR로 들어온 성인과 새로 만든 아이를 빈자리에 앉힌다(T162). 자리 없이 들어오면 '이 가족과 출발'이 그 사람을 빼고 여행을 만들었다.
// 운전석은 만든 사람 자리라 고르지 않고, 뒤 가운데는 차 좌석 화면(C16B, 네 칸)에 없어 고르지 않는다. 다 차면 자리 없음(사람이 좌석 배정에서 앉힘).
const ADULT_SEATS = ["ROW_1_RIGHT", "ROW_2_LEFT", "ROW_2_RIGHT"];
const CHILD_SEATS = ["ROW_2_LEFT", "ROW_2_RIGHT", "ROW_1_RIGHT"];
// 그룹 줄을 잠근 트랜잭션 안에서 부른다(초대 참여·아이 만들기 모두 FOR UPDATE) — 동시에 들어온 둘이 같은 자리를 고르지 않게.
async function freeSeat(db, groupId, order) {
  const { rows } = await db.query("SELECT seat FROM group_members WHERE group_id = $1 AND seat IS NOT NULL", [groupId]);
  const taken = new Set(rows.map((r) => r.seat));
  return order.find((s) => !taken.has(s)) ?? null;
}

// 초대 코드는 숫자 4자리라 짐작할 수 있다. 틀린 코드(없음·만료) 시도를 프로세스마다 10분 창으로 묶는다:
// 프로필 하나에 10번, 모두 합쳐 60번. 넘으면 429. 코드 수명(24시간)·그룹당 하나·대표가 구성원을 보고 빼기와 함께 막는다.
// ponytail: 파드마다 따로 센다(지금 2개). 공개 규모가 커지면 공용 저장소의 카운터나 더 긴 코드로.
const WINDOW = 10 * 60_000;
const LIMITS = { all: 60, profile: 10 };
const misses = new Map();
const recent = (key) => (misses.get(key) ?? []).filter((t) => Date.now() - t < WINDOW);
const throttled = (keys) => keys.some(([key, limit]) => recent(key).length >= limit);
function missed(keys) {
  if (misses.size > 5000) for (const [key] of misses) if (!recent(key).length) misses.delete(key);
  for (const [key] of keys) misses.set(key, [...recent(key), Date.now()]);
}

// 프로필 저장소의 트랜잭션. 부른 사람의 프로필 줄을 먼저 FOR SHARE로 잡는다 — 그 사이 프로필 지우기가 끝나
// 지워진 사람이 그룹에 다시 들어가지 않게(프로필 지우기는 FOR UPDATE로 잡고 group_members를 치운다).
async function tx(meId, fn) {
  const db = await profilesDb().connect();
  try {
    await db.query("BEGIN");
    if (!(await db.query("SELECT 1 FROM profiles WHERE id = $1 FOR SHARE", [meId])).rowCount) fail(401, "알 수 없는 프로필 토큰");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    // 자리 유일 제약은 커밋 때 검사한다(맞바꾸기). 동시에 같은 자리를 정한 요청이 이기면 진 쪽은 여기로 온다.
    if (e?.code === "23505" && e.constraint === "group_members_seat") fail(409, "같은 자리에 두 사람을 앉힐 수 없음");
    throw e;
  } finally {
    db.release();
  }
}

const MEMBERS = `SELECT m.group_id, m.profile_id, m.seat, m.joined_at, p.name, p.character, (p.photo IS NOT NULL) AS has_photo,
  EXISTS (SELECT 1 FROM voice_prints v WHERE v.profile_id = p.id AND cardinality(v.vector) = ${DIMS}) AS has_voice,
  p.consent, p.consent_version, p.managed_by
  FROM group_members m JOIN profiles p ON p.id = m.profile_id WHERE m.group_id = ANY($1::text[])`;
const kindOf = (g) => (g.kind === "family" ? "family" : "guest"); // 옛 그룹의 crew는 동승
const roleOf = (g, m) => (m.profile_id === g.owner_id ? "owner" : m.managed_by ? "child" : "adult");
// 구성원의 동의: 계정 동의(아이는 보호자 동의)가 지금 문구 판으로 켜져 있는지(T128과 같은 규칙). 다른 판이면 다시 동의를 받는다.
const consentOf = (m) => accountConsents({ consent: m.consent, consentVersion: m.consent_version || null });
const RANK = { owner: 0, adult: 1, child: 2 };

async function views(db, groups) {
  if (!groups.length) return [];
  const ids = groups.map((g) => g.id);
  const { rows: members } = await db.query(MEMBERS, [ids]);
  const { rows: invites } = await db.query(
    `SELECT group_id, code, expires_at FROM invites WHERE group_id = ANY($1::text[]) AND cancelled_at IS NULL AND expires_at > now()
     AND code ~ '^(FAMILY|TRIP)-[0-9]{4}$' ORDER BY created_at DESC`,
    [ids]
  );
  return groups.map((g) => {
    const invite = invites.find((i) => i.group_id === g.id);
    return {
      id: g.id,
      name: g.name,
      kind: kindOf(g),
      ownerId: g.owner_id,
      members: members
        .filter((m) => m.group_id === g.id)
        .map((m) => {
          const role = roleOf(g, m);
          return {
            profileId: m.profile_id,
            name: m.name,
            character: m.character ?? "",
            hasPhoto: m.has_photo,
            hasVoice: m.has_voice,
            consent: consentOf(m),
            role,
            seat: m.seat ?? null,
            pending: false,
            ...(role === "child" ? { guardianId: m.managed_by } : {}),
            joinedAt: m.joined_at,
          };
        })
        .sort((a, b) => RANK[a.role] - RANK[b.role] || a.joinedAt - b.joinedAt || a.profileId.localeCompare(b.profileId))
        .map(({ joinedAt, ...m }) => m),
      invite: invite ? inviteOf(invite.code, invite.expires_at.getTime()) : null,
    };
  });
}
const viewOf = async (db, g) => [200, (await views(db, [g]))[0]];

// 그룹 하나와 구성원. 부른 사람이 구성원이 아니면 없는 그룹과 같다.
async function load(db, groupId, meId, lock = false) {
  if (typeof groupId !== "string" || !GROUP_ID.test(groupId)) fail(404, "없는 그룹");
  const { rows } = await db.query(`SELECT * FROM groups WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`, [groupId]);
  const g = rows[0];
  const { rows: members } = g ? await db.query(MEMBERS, [[g.id]]) : { rows: [] };
  const me = members.find((m) => m.profile_id === meId);
  if (!g || !me) fail(404, "없는 그룹");
  return { g, members, me };
}
const memberOf = (members, profileId) => members.find((m) => m.profile_id === profileId) ?? fail(404, "그룹에 없는 구성원");
const tooManyGroups = async (db, profileId) =>
  (await db.query("SELECT count(*)::int AS n FROM group_members WHERE profile_id = $1", [profileId])).rows[0].n >= MAX_GROUPS;

const ROUTES = { list: ["GET", "POST"], invites: ["POST"], children: ["POST"], seats: ["PUT"], member: ["PATCH", "DELETE"], voice: ["POST", "DELETE"] };

// /api/groups… deps는 server.js의 도구(같은 검사·같은 지우기를 쓰려고).
export async function groups(req, seg, b, { profileOf, text, bool, oneOf, obj, seats, enrollment, enrolled, deleteProfiles }) {
  const [id, sub, profileId, leaf] = seg;
  const route = !id
    ? "list"
    : seg.length === 2 && ["invites", "children", "seats"].includes(sub)
      ? sub
      : sub === "members" && profileId && seg.length === 3
        ? "member"
        : sub === "members" && profileId && leaf === "voice" && seg.length === 4
          ? "voice"
          : fail(404, "없는 경로");
  if (!ROUTES[route].includes(req.method)) fail(405, `${ROUTES[route].join(", ")}만 됨`);
  const me = (await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함");

  if (route === "list" && req.method === "GET") {
    const { rows } = await profilesDb().query(
      "SELECT g.* FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.profile_id = $1 ORDER BY g.created_at, g.id",
      [me.id]
    );
    return [200, { items: await views(profilesDb(), rows) }];
  }
  if (route === "list") {
    const name = text(b.name, 20, "name");
    const kind = oneOf(b.kind, KINDS, "kind");
    return tx(me.id, async (db) => {
      if (await tooManyGroups(db, me.id)) fail(409, `그룹은 ${MAX_GROUPS}개까지`);
      const g = { id: randomUUID(), kind, name, owner_id: me.id };
      await db.query("INSERT INTO groups (id, kind, name, owner_id) VALUES ($1, $2, $3, $4)", [g.id, kind, name, me.id]);
      // 만든 사람(차를 모는 사람)을 운전석에 둔다. 동승 그룹도 같다 — 자리 없이 시작하면 차의 참석 QR(운전석이 차 계정)이 403이었다(T162).
      await db.query("INSERT INTO group_members (group_id, profile_id, seat) VALUES ($1, $2, 'ROW_1_LEFT')", [g.id, me.id]);
      const [, view] = await viewOf(db, g);
      return [201, view];
    });
  }

  if (route === "invites") {
    // 새 코드를 만들면 이 그룹의 이전 코드는 바로 못 쓴다(그룹당 하나). 그룹 줄을 잠가 동시에 두 개가 살지 않게.
    return tx(me.id, async (db) => {
      const { g } = await load(db, id, me.id, true);
      await db.query("UPDATE invites SET cancelled_at = now() WHERE group_id = $1 AND cancelled_at IS NULL", [g.id]);
      // 코드는 1만 개뿐이라 끝난 지 하루 지난 코드는 비워 다시 쓴다(그 하루 동안은 '만료된 코드'로 답한다).
      await db.query(`DELETE FROM invites WHERE code ~ '^(FAMILY|TRIP)-[0-9]{4}$' AND (expires_at < now() - interval '1 day' OR cancelled_at < now() - interval '1 day')`);
      for (let i = 0; i < 50; i++) {
        const code = `${PREFIX[kindOf(g)]}-${String(randomInt(10_000)).padStart(4, "0")}`;
        const { rows } = await db.query(
          "INSERT INTO invites (code, group_id, max_uses, expires_at) VALUES ($1, $2, 0, now() + interval '24 hours') ON CONFLICT (code) DO NOTHING RETURNING expires_at",
          [code, g.id]
        );
        if (rows[0]) return [201, inviteOf(code, rows[0].expires_at.getTime())];
      }
      fail(503, "초대 코드를 만들지 못했어요. 잠시 뒤 다시 해 주세요");
    });
  }

  if (route === "children") {
    // 계정 없는 아이 프로필. 만든 사람이 보호자(managed_by)이고, 동의는 보호자 동의다. 토큰은 없다 — 보호자 기기가 대신 쓴다.
    const name = text(b.name, 20, "name");
    const character = b.character === undefined ? "" : text(b.character, 20, "character");
    const consent = bool(b.guardianConsent, "guardianConsent");
    const version = b.consentVersion === undefined ? CONSENT_VERSION : text(b.consentVersion, 40, "consentVersion");
    return tx(me.id, async (db) => {
      const { g, members } = await load(db, id, me.id, true);
      if (members.length >= MAX_MEMBERS) fail(409, `그룹 구성원은 ${MAX_MEMBERS}명까지`);
      const child = randomUUID();
      await db.query(
        `INSERT INTO profiles (id, name, consent_default, character, managed_by, consent, consent_at, consent_version)
         VALUES ($1, $2, false, $3, $4, $5, CASE WHEN $5 THEN now() END, CASE WHEN $5 THEN $6 ELSE '' END)`,
        [child, name, character, me.id, consent, version]
      );
      await db.query("INSERT INTO group_members (group_id, profile_id, seat) VALUES ($1, $2, $3)", [g.id, child, await freeSeat(db, g.id, CHILD_SEATS)]);
      const [, view] = await viewOf(db, g);
      return [201, view];
    });
  }

  if (route === "seats") {
    // 자리를 한 번에 바꾼다(맞바꾸기). 적지 않은 구성원의 자리는 그대로. 바꾼 뒤 같은 자리에 둘이면 409.
    const changes = Object.entries(obj(b.seats, "seats")).map(([who, seat]) => [who, seat === null ? null : oneOf(seat, seats, `seats.${who}`)]);
    return tx(me.id, async (db) => {
      const { g, members } = await load(db, id, me.id, true);
      const after = new Map(members.map((m) => [m.profile_id, m.seat ?? null]));
      for (const [who, seat] of changes) {
        if (!after.has(who)) fail(400, "seats: 이 그룹 구성원의 profileId만");
        after.set(who, seat);
      }
      const taken = [...after.values()].filter(Boolean);
      if (new Set(taken).size !== taken.length) fail(409, "같은 자리에 두 사람을 앉힐 수 없음");
      for (const [who, seat] of changes) await db.query("UPDATE group_members SET seat = $3 WHERE group_id = $1 AND profile_id = $2", [g.id, who, seat]);
      return viewOf(db, g);
    });
  }

  if (route === "member" && req.method === "PATCH") {
    // 보호자가 아이의 이름·캐릭터·보호자 동의를 고친다. 성인은 자기 프로필(/profiles/me)에서 고친다.
    const patch = {
      name: b.name === undefined ? null : text(b.name, 20, "name"),
      character: b.character === undefined ? null : text(b.character, 20, "character"),
      consent: b.guardianConsent === undefined ? null : bool(b.guardianConsent, "guardianConsent"),
      version: b.consentVersion === undefined ? CONSENT_VERSION : text(b.consentVersion, 40, "consentVersion"),
    };
    return tx(me.id, async (db) => {
      const { g, members } = await load(db, id, me.id, true);
      const target = memberOf(members, profileId);
      if (target.managed_by !== me.id) fail(403, "아이의 보호자만 고칠 수 있음");
      await db.query(
        `UPDATE profiles SET name = COALESCE($2, name), character = COALESCE($3, character), consent = COALESCE($4::boolean, consent),
           consent_at = CASE WHEN $4::boolean IS NULL THEN consent_at WHEN $4::boolean THEN now() END,
           consent_version = CASE WHEN $4::boolean IS NULL THEN consent_version WHEN $4::boolean THEN $5 ELSE '' END,
           updated_at = now() WHERE id = $1`,
        [target.profile_id, patch.name, patch.character, patch.consent, patch.version]
      );
      return viewOf(db, g);
    });
  }

  if (route === "member") {
    // 빼기·나가기. 대표는 남을 빼고, 성인은 자기만 나가고, 아이는 대표나 그 보호자가 뺀다.
    // 아이를 빼면 아이 프로필을 지운다(계정 없는 구성원, ADR-0009) — 프로필 지우기와 같은 정리(탔던 여행의 동의 세대가 오름).
    // 성인이 나가면 그가 보호자인 아이도 함께, 대표가 나가면 그룹을 없애고 그룹의 아이를 모두 지운다.
    const remove = await tx(me.id, async (db) => {
      const { g, members, me: mine } = await load(db, id, me.id, true);
      const target = memberOf(members, profileId);
      const role = roleOf(g, target);
      const children = members.filter((m) => roleOf(g, m) === "child");
      if (role === "owner") {
        if (target.profile_id !== me.id) fail(403, "대표는 본인만 나갈 수 있음");
        await db.query("DELETE FROM group_members WHERE group_id = $1", [g.id]);
        await db.query("DELETE FROM invites WHERE group_id = $1", [g.id]);
        await db.query("DELETE FROM groups WHERE id = $1", [g.id]);
        return children.map((m) => m.profile_id);
      }
      const owner = roleOf(g, mine) === "owner";
      if (role === "child") {
        if (!owner && target.managed_by !== me.id) fail(403, "아이는 대표나 보호자만 뺄 수 있음");
        return [target.profile_id];
      }
      if (!owner && target.profile_id !== me.id) fail(403, "다른 성인은 대표만 뺄 수 있음");
      await db.query("DELETE FROM group_members WHERE group_id = $1 AND profile_id = $2", [g.id, target.profile_id]);
      return children.filter((m) => m.managed_by === target.profile_id).map((m) => m.profile_id);
    });
    for (const child of remove) await deleteProfiles(child);
    return [204];
  }

  // 목소리(route === "voice"): 보호자가 아이 것을(본인 것도 됨 — 보통은 /profiles/me/voice). 본문은 /profiles/me/voice와 같다
  // (기기가 계산한 값 JSON 또는 WAV, 같은 검사, ADR-0023). 아이는 보호자 동의가 켜져 있을 때만 등록한다.
  const allowed = async () => {
    const { members } = await load(profilesDb(), id, me.id);
    const target = memberOf(members, profileId);
    if (target.profile_id !== me.id && target.managed_by !== me.id) fail(403, "아이의 목소리는 보호자만 등록할 수 있음");
    if (req.method === "POST" && target.profile_id !== me.id && !consentOf(target)) fail(409, "보호자 동의가 꺼져 있어 등록하지 않음");
    return target.profile_id;
  };
  const target = await allowed(); // 본문을 읽기 전에
  if (req.method === "DELETE") {
    await profilesDb().query("DELETE FROM voice_prints WHERE profile_id = $1", [target]);
    return [204];
  }
  const print = await enrollment(req);
  await allowed(); // 본문을 받는 사이 빠졌거나 동의가 꺼졌으면 저장하지 않는다
  await profilesDb()
    .query(
      `INSERT INTO voice_prints (profile_id, vector, seconds) VALUES ($1, $2, $3)
       ON CONFLICT (profile_id) DO UPDATE SET vector = $2, seconds = $3, updated_at = now()`,
      [target, print.vector, print.seconds]
    )
    .catch((e) => (e?.code === "23503" ? fail(404, "그룹에 없는 구성원") : Promise.reject(e)));
  return enrolled(print);
}

// /api/group-invites/{code}: 토큰 없이 미리보기(GET), 프로필 토큰으로 성인 구성원이 되기(POST).
// 계정 동의는 그대로 따라간다 — 꺼져 있으면 구성원의 consent가 false이고 화면이 동의를 받는다.
export async function groupInvites(req, seg, { profileOf }) {
  if (seg.length !== 1) fail(404, "없는 초대 코드");
  if (req.method !== "GET" && req.method !== "POST") fail(405, "GET, POST만 됨");
  const me = req.method === "POST" ? ((await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함")) : null;
  const keys = [["all", LIMITS.all], ...(me ? [[`profile:${me.id}`, LIMITS.profile]] : [])];
  if (throttled(keys)) fail(429, "초대 코드를 너무 많이 틀렸어요. 잠시 뒤 다시 해 주세요");
  const code = String(seg[0]).toUpperCase();
  const look = async (db, lock) => {
    const { rows } = CODE.test(code)
      ? await db.query(
          `SELECT i.group_id, i.expires_at, (i.expires_at > now() AND i.cancelled_at IS NULL) AS alive, g.name, g.kind, g.owner_id, o.name AS owner_name
           FROM invites i JOIN groups g ON g.id = i.group_id LEFT JOIN profiles o ON o.id = g.owner_id WHERE i.code = $1 ${lock ? "FOR UPDATE OF g" : ""}`,
          [code]
        )
      : { rows: [] };
    if (!rows[0]) (missed(keys), fail(404, "없는 초대 코드"));
    if (!rows[0].alive) (missed(keys), fail(410, "만료됐거나 새 코드로 바뀐 초대예요. 새 코드를 받아 주세요"));
    return rows[0];
  };
  if (!me) {
    const i = await look(profilesDb());
    return [200, { groupName: i.name, kind: kindOf(i), ownerName: i.owner_name ?? "", expiresAt: i.expires_at.getTime() }];
  }
  return tx(me.id, async (db) => {
    const i = await look(db, true);
    const { rows: members } = await db.query("SELECT profile_id FROM group_members WHERE group_id = $1", [i.group_id]);
    if (!members.some((m) => m.profile_id === me.id)) {
      // 같은 코드로 다시 들어오면 그대로 200(구성원을 늘리지 않음). 코드는 24시간 동안 여러 사람이 쓴다.
      if (members.length >= MAX_MEMBERS) fail(409, `그룹 구성원은 ${MAX_MEMBERS}명까지`);
      if (await tooManyGroups(db, me.id)) fail(409, `그룹은 ${MAX_GROUPS}개까지`);
      await db.query("INSERT INTO group_members (group_id, profile_id, seat) VALUES ($1, $2, $3)", [i.group_id, me.id, await freeSeat(db, i.group_id, ADULT_SEATS)]);
      await db.query("UPDATE invites SET uses = uses + 1 WHERE code = $1", [code]);
    }
    const { g } = await load(db, i.group_id, me.id);
    return viewOf(db, g);
  });
}

// POST /api/trips {groupId}: 자리가 정해진 구성원(부른 사람이 그 그룹의 구성원일 때만). server.js가 여행을 만든다.
export async function groupForTrip(meId, groupId, db = profilesDb()) {
  const { g, members } = await load(db, groupId, meId);
  const seated = members.filter((m) => m.seat);
  if (!seated.length) fail(409, "자리가 정해진 구성원이 없어요. 좌석을 먼저 정해 주세요");
  return {
    id: g.id,
    name: g.name,
    members: seated.map((m) => ({ profileId: m.profile_id, name: m.name, character: m.character ?? "", seat: m.seat, consent: consentOf(m), guardianId: m.managed_by })),
  };
}

// 같은 그룹 구성원인지(사진 보기).
export async function shareGroup(a, b, db = profilesDb()) {
  const { rowCount } = await db.query(
    "SELECT 1 FROM group_members x JOIN group_members y ON y.group_id = x.group_id WHERE x.profile_id = $1 AND y.profile_id = $2 LIMIT 1",
    [a, b]
  );
  return rowCount > 0;
}
