// 여행의 장소 기록과 내 여행·콘텐츠 목록(T131, docs/api/places.md).
// 장소는 차가 내비에서 읽은 출발·경유·도착 이름이다. 지도 제공자 없이 여행 중 기록한 좌표와 이 이름으로 지도를 그린다(개편 계획 결정 5).
import { randomUUID } from "node:crypto";
import { profilesDb, tripsDb } from "./db.js";
import { momentSpan } from "./scenes.js";

const fail = (status, error) => {
  throw { status, error };
};
export const PLACE_KINDS = ["start", "stop", "approaching", "arrived", "destination"];
const MAX_PLACES = 200; // 여행 하나에. 차는 상태가 바뀔 때(출발·경유·곧 도착·도착·목적지 바꿈)만 올린다. 넘으면 at이 가장 이른 것부터 버린다
const MAX_ROUTE = 200; // 내 여행 하나의 경로 점
const MAX_TRIPS = 50;
const MAX_LINES = 30; // 콘텐츠 하나의 자막 줄(장면 구간은 30초 안팎)

// POST /trips/{code}/places. 여행 줄을 잠근 채 부른다(handle). v는 server.js의 입력 검사(같은 문구를 쓰려고).
// places는 늘 at 순서로 둔다(같은 at이면 받은 순서) — 늦게 도착한 '곧 도착'이 그 뒤의 '도착'을 덮지 않게, 지금 상태는 at이 가장 큰 마지막 항목이다.
export function addPlace(trip, caller, b, { text, num, int, oneOf }) {
  const kind = oneOf(b.kind, PLACE_KINDS, "kind");
  const name = text(b.name, 100, "name");
  const hasLat = b.lat !== undefined;
  if (hasLat !== (b.lng !== undefined)) fail(400, "lat, lng: 둘 다 있거나 둘 다 없음");
  const now = Date.now();
  const place = {
    id: randomUUID().slice(0, 8),
    kind,
    name,
    // 통신이 끊겼다가 나중에 올리는 경우가 있어 시각을 받는다. 여행을 만들기 전·한참 뒤의 시각은 받지 않는다.
    at: b.at === undefined ? now : int(b.at, trip.createdAt - 60_000, now + 60_000, "at"),
    ...(hasLat ? { lat: num(b.lat, -90, 90, "lat"), lng: num(b.lng, -180, 180, "lng") } : {}),
    ...(b.etaSeconds !== undefined ? { etaSeconds: int(b.etaSeconds, 0, 86_400, "etaSeconds") } : {}),
    by: caller.id,
  };
  trip.places = [...(trip.places ?? []), place].sort((a, b) => a.at - b.at); // 정렬은 안정적이라 같은 at은 받은 순서
  if (trip.places.length > MAX_PLACES) trip.places.splice(0, trip.places.length - MAX_PLACES);
  return place;
}

// 그 시각에 어디쯤이었는지: 그 시각 전에 남은 마지막 장소의 이름(곧 도착·목적지면 그쪽으로 가던 길). places는 at 순서다.
const placeAt = (places, at) => places.findLast((p) => p.at <= at)?.name ?? null;

// GET /profiles/me/trips: 내 프로필이 참가한 여행을 최신 순으로. 여행을 가로질러 두 저장소를 읽는다.
// ponytail: 참가자 검색은 문서 포함(@>)이라 여행 표를 훑는다. 여행이 수만 개가 되면 참가자 표나 GIN 색인으로.
export async function myTrips(me) {
  const { rows } = await tripsDb().query(
    "SELECT doc FROM trips WHERE doc->'participants' @> $1::jsonb ORDER BY created_at DESC, code LIMIT $2",
    [JSON.stringify([{ profileId: me.id }]), MAX_TRIPS]
  );
  const trips = rows.map((r) => r.doc);
  return [200, { items: await tripItems(trips, (t) => t.participants.find((p) => p.profileId === me.id)?.consent) }];
}

// GET /trips/{code}/contents(F6): 프로필 토큰이 없는 기기(차)가 지금 여행 하나의 콘텐츠 기록을 /profiles/me/trips 항목과 같은 모양으로 읽는다.
// 기록본과 같이 녹음에 동의한 참가자 토큰만(아니면 403). 영상 파일은 지금처럼 전원 동의 규칙(short-assets.md).
export async function tripContents(trip, caller) {
  if (!caller.consent) fail(403, "녹음에 동의한 참가자만 볼 수 있음");
  return [200, (await tripItems([trip], () => true))[0]];
}

// 여행들을 콘텐츠 기록 항목으로. open(trip)이 참이면(그 여행에서 읽는 사람이 녹음에 동의) 장소·경로·콘텐츠를 채운다 —
// 기록본과 같은 규칙이고, 아니면 빈 목록이다(T136: 장소도 동의한 참가자만).
async function tripItems(trips, consented) {
  const open = trips.filter(consented);
  const codes = open.map((t) => t.code);
  const generations = open.map((t) => t.generation ?? 1);

  // 경로: 지금 동의 세대의 좌표 있는 발화를 시간순으로 골고루 줄인다(첫 점·끝 점은 남김).
  const { rows: points } = codes.length
    ? await tripsDb().query(
        `WITH g AS (SELECT * FROM unnest($1::text[], $2::int[]) AS g(code, gen)),
         pts AS (
           SELECT u.trip_code, u.at, u.lat, u.lng, row_number() OVER w AS rn, count(*) OVER (PARTITION BY u.trip_code) AS n
           FROM utterances u JOIN g ON u.trip_code = g.code AND u.generation = g.gen
           WHERE u.lat IS NOT NULL AND u.text <> ''
           WINDOW w AS (PARTITION BY u.trip_code ORDER BY u.at, u.device, u.seq)
         )
         SELECT trip_code, at, lat, lng FROM pts
         WHERE n <= $3 OR rn = n OR (rn - 1) % ceil(n / ($3 - 1)::numeric)::int = 0
         ORDER BY trip_code, rn`,
        [codes, generations, MAX_ROUTE]
      )
    : { rows: [] };
  // 콘텐츠: 서버에 보관을 마친 기본 영상(기기에서 만든 것)과 생성을 마친 영상. 지금 동의 세대의 것만.
  const { rows: media } = codes.length
    ? await tripsDb().query(
        `WITH g AS (SELECT * FROM unnest($1::text[], $2::int[]) AS g(code, gen))
         SELECT a.id, a.trip_code, a.moment_id, (a.media->>'seconds')::float AS seconds, a.created_at, 'device' AS kind
           FROM short_assets a JOIN g ON a.trip_code = g.code AND a.generation = g.gen WHERE a.state = 'completed'
         UNION ALL
         SELECT s.id, s.trip_code, s.moment_id, (s.plan->>'seconds')::float AS seconds, s.created_at, 'generated' AS kind
           FROM short_generations s JOIN g ON s.trip_code = g.code AND s.generation = g.gen WHERE s.state = 'completed'`,
        [codes, generations]
      )
    : { rows: [] };
  // 장면 구간(momentSpan)의 발화: 갤러리 타일의 캐릭터(말한 사람)와 플레이어 자막 줄(F6). 지금 동의 세대의 것만, 장면마다 MAX_LINES줄.
  const byCode = new Map(open.map((t) => [t.code, t]));
  const spans = [...new Map(media.map((r) => [`${r.trip_code}:${r.moment_id}`, r])).values()]
    .map((r) => ({ r, moment: byCode.get(r.trip_code).moments.find((x) => x.id === r.moment_id) }))
    .filter((x) => x.moment)
    .map(({ r, moment }) => ({ code: r.trip_code, gen: byCode.get(r.trip_code).generation ?? 1, id: moment.id, ...momentSpan(moment) }));
  const { rows: said } = spans.length
    ? await tripsDb().query(
        `WITH s AS (SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::bigint[], $5::bigint[]) AS s(code, gen, id, f, t)),
         l AS (
           SELECT s.code, s.id, u.at, u.participant_id, COALESCE(u.edited_text, u.asr_text, u.text) AS text,
                  row_number() OVER (PARTITION BY s.code, s.id ORDER BY u.at, u.device, u.seq) AS rn
           FROM s JOIN utterances u ON u.trip_code = s.code AND u.generation = s.gen AND u.at BETWEEN s.f AND s.t
           WHERE u.text <> ''
         )
         SELECT code, id, at, participant_id, text FROM l WHERE rn <= $6 ORDER BY code, id, rn`,
        [spans.map((x) => x.code), spans.map((x) => x.gen), spans.map((x) => x.id), spans.map((x) => Math.round(x.from)), spans.map((x) => Math.round(x.to)), MAX_LINES]
      )
    : { rows: [] };
  // 캐릭터는 프로필의 지금 값을 먼저(숏폼 구성과 같음), 없으면 참가할 때 적어 둔 값.
  const ids = [...new Set(trips.flatMap((t) => t.participants.map((p) => p.profileId).filter(Boolean)))];
  const { rows: chars } = ids.length ? await profilesDb().query("SELECT id, character FROM profiles WHERE id = ANY($1::uuid[])", [ids]) : { rows: [] };
  const character = new Map(chars.map((r) => [r.id, r.character]));

  return trips.map((trip) => {
    const shown = open.includes(trip);
    const places = shown ? (trip.places ?? []) : [];
    const members = trip.participants.map((p) => ({
      participantId: p.id,
      name: p.name,
      character: character.get(p.profileId) || p.character || "",
      seat: p.seat,
      ...(p.profileId ? { profileId: p.profileId } : {}),
    }));
    const member = new Map(members.map((p) => [p.participantId, p]));
    const route = points.filter((r) => r.trip_code === trip.code).map((r) => [r.lat, r.lng, Number(r.at)]);
    const contents = media
      .filter((r) => r.trip_code === trip.code)
      .map((r) => {
        const moment = trip.moments.find((x) => x.id === r.moment_id);
        const at = moment?.at ?? new Date(r.created_at).getTime();
        const span = moment ? momentSpan(moment) : null;
        // 자막 줄: 말한 사람을 확인한 줄만 이름을 붙인다(모르면 null — 화면이 이름을 지어내지 않게).
        const lines = said
          .filter((l) => l.code === trip.code && l.id === r.moment_id)
          .map((l) => ({ at: Number(l.at), participantId: l.participant_id ?? null, name: member.get(l.participant_id)?.name ?? null, text: l.text }));
        const cast = [...new Set(lines.map((l) => l.participantId).filter((id) => member.has(id)))].map((id) => {
          const p = member.get(id);
          return { participantId: id, name: p.name, character: p.character };
        });
        return {
          id: r.id,
          momentId: r.moment_id,
          title: moment?.label || trip.title || "",
          seconds: r.seconds,
          at,
          from: span?.from ?? null,
          to: span?.to ?? null,
          lat: moment?.lat ?? null,
          lng: moment?.lng ?? null,
          place: placeAt(places, at),
          kind: r.kind,
          cast,
          lines,
          // 파일은 지금처럼 그 여행의 참가자 토큰으로 받는다(short-assets.md). 토큰이 없으면 프로필로 다시 참가해 받는다.
          url: `/api/trips/${trip.code}/${r.kind === "device" ? "short-assets" : "short-generations"}/${r.id}/file`,
        };
      })
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    return {
      code: trip.code,
      title: trip.title,
      status: trip.status,
      createdAt: trip.createdAt,
      startedAt: trip.startedAt ?? null,
      endedAt: trip.endedAt ?? null,
      groupName: trip.groupName ?? null,
      members,
      places,
      route,
      contents,
    };
  });
}
