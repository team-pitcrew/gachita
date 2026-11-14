// 이메일 계정과 로그인(T128, docs/api/accounts.md). 계정은 기존 프로필 한 줄에 이메일·비밀번호를 붙인 것이고,
// 로그인은 그 프로필의 기기 토큰(tokens 표, ADR-0009)을 하나 더 만든다. 비밀번호는 scrypt 값으로만 남는다.
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { profilesDb } from "./db.js";

const fail = (status, error) => {
  throw { status, error };
};
const derive = promisify(scrypt);

// scrypt 비용: N=2^14, r=8, p=1(메모리 16 MB, 한 번에 수십 ms). 값에 비용을 같이 적어 두어 나중에 올려도 옛 값을 읽는다.
const COST = { N: 16384, r: 8, p: 1 };
const KEY_BYTES = 64;
// 계정 동의 문구의 판. 화면이 판을 보내지 않으면 이 값을 남긴다.
export const CONSENT_VERSION = "2026-11-14";
// 계정 동의가 여행으로 이어지는지: 켜져 있고, 지금 문구 판에 동의했을 때만. 문구가 바뀌면(판을 올리면) 다시 동의를 받는다.
// 본인이 자기 프로필 토큰으로 여행에 들어갈 때만 쓴다(참가, 차량 QR 초대) — 다른 사람이 대신 켜지 못한다.
export const accountConsents = (profile) => profile.consent === true && profile.consentVersion === CONSENT_VERSION;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, KEY_BYTES, COST);
  return `scrypt:${COST.N}:${COST.r}:${COST.p}:${salt.toString("base64")}:${key.toString("base64")}`;
}

// 저장한 값과 비교한다. 모양이 이상한 값은 틀린 것으로 본다.
export async function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, key] = String(stored ?? "").split(":");
  if (kind !== "scrypt" || !salt || !key) return false;
  const want = Buffer.from(key, "base64");
  if (want.length !== KEY_BYTES) return false; // 잘린 값도 앞부분은 맞아 보인다(scrypt 출력은 길이를 줄이면 앞부분이 같음)
  const got = await derive(password, Buffer.from(salt, "base64"), want.length, { N: Number(N), r: Number(r), p: Number(p) }).catch(() => null);
  return Boolean(got) && got.length === want.length && timingSafeEqual(got, want);
}

// 없는 이메일에도 같은 계산을 한다 — 응답이 빨리 오는지로 가입한 이메일인지 알아내지 못하게.
let dummy;
const dummyHash = () => (dummy ??= hashPassword(randomBytes(16).toString("hex")));

// NUL과 짝 없는 서로게이트는 Postgres의 text가 받지 않아(22021) 묻는 순간 500이 된다 — 그 전에 400으로 거른다(server.js의 text와 같은 기준).
const writable = (v) => !v.includes("\0") && v.isWellFormed();
const email = (v) => {
  if (typeof v === "string" && !writable(v)) fail(400, "email: 쓸 수 없는 문자(NUL, 짝 없는 서로게이트)");
  const e = typeof v === "string" ? v.trim().toLowerCase() : "";
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : fail(400, "email: 이메일 주소");
};
const password = (v) => {
  if (typeof v !== "string" || v.includes("\0") || !v.isWellFormed()) fail(400, "password: 글자 8~72자");
  const n = [...v].length;
  return n >= 8 && n <= 72 ? v : fail(400, "password: 글자 8~72자");
};
// 선택 칸의 빈 글은 보내지 않은 것과 같다(화면이 빈 입력칸을 그대로 보내도 되게).
const optional = (v, max, name, text) => (v === undefined || v === "" ? undefined : text(v, max, name));
const bearer = (req) => /^Bearer ([A-Za-z0-9_-]{40,})$/.exec(req.headers.authorization ?? "")?.[1];
const emailTaken = (e) => e?.code === "23505" && e.constraint === "profiles_email";

// POST /api/accounts, POST /api/sessions. deps는 server.js의 프로필 도구(같은 검사·같은 모양을 쓰려고).
export async function accounts(req, kind, b, { profileOf, profileById, issueToken, text, tokenHash }) {
  if (req.method !== "POST") fail(405, "POST만 됨");
  const device = optional(b.device, 20, "device", text) ?? "";
  if (kind === "sessions") {
    if (typeof b.email !== "string" || typeof b.password !== "string") fail(400, "email, password: 글자");
    if (!writable(b.email)) fail(400, "email: 쓸 수 없는 문자(NUL, 짝 없는 서로게이트)"); // 계정이 있는지와 관계없이 같은 400
    const { rows } = await profilesDb().query("SELECT id, password_hash FROM profiles WHERE email = $1", [b.email.trim().toLowerCase()]);
    const ok = await verifyPassword(b.password, rows[0]?.password_hash ?? (await dummyHash()));
    if (!rows[0] || !ok) fail(401, "이메일 또는 비밀번호가 맞지 않아요");
    const token = await issueToken(rows[0].id, device);
    return [200, { ...(await profileById(rows[0].id)), token }];
  }

  const address = email(b.email);
  const plain = password(b.password);
  const me = await profileOf(req); // 토큰이 없으면 null, 틀리면 401
  const secret = await hashPassword(plain);
  if (me) {
    // 기기 프로필에 계정을 붙인다. 이름·캐릭터는 보냈을 때만(빈 글이 아닐 때만) 바꾼다. 이미 계정이 있는 프로필은 바꾸지 않는다(비밀번호 바꾸기가 아님).
    const name = optional(b.name, 20, "name", text) ?? me.name;
    const character = optional(b.character, 20, "character", text) ?? me.character;
    const { rowCount } = await profilesDb()
      .query("UPDATE profiles SET email = $2, password_hash = $3, name = $4, character = $5, updated_at = now() WHERE id = $1 AND email IS NULL", [me.id, address, secret, name, character])
      .catch((e) => (emailTaken(e) ? fail(409, "이미 가입한 이메일") : Promise.reject(e)));
    if (!rowCount) fail(409, "이미 이메일 계정이 있는 프로필");
    // 토큰은 새로 만들지 않는다. 응답 모양을 같게 하려고 보낸 토큰을 그대로 돌려준다.
    return [200, { ...(await profileById(me.id)), token: bearer(req) }];
  }
  const id = randomUUID();
  const name = text(b.name, 20, "name");
  const character = optional(b.character, 20, "character", text) ?? "";
  const token = randomBytes(32).toString("base64url");
  // 첫 토큰은 옛 칸(token_hash)에도 적는다 — POST /profiles와 같은 까닭(이전 이미지로 되돌려도 읽히게).
  await profilesDb()
    .query("INSERT INTO profiles (id, token_hash, name, consent_default, character, email, password_hash) VALUES ($1, $2, $3, false, $4, $5, $6)", [id, tokenHash(token), name, character, address, secret])
    .catch((e) => (emailTaken(e) ? fail(409, "이미 가입한 이메일") : Promise.reject(e)));
  await issueToken(id, device, token);
  return [201, { ...(await profileById(id)), token }];
}
