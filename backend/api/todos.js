import { createHash } from "node:crypto";

// 차량 Todos.kt와 같은 명시적 규칙입니다. LLM 추출이나 장소 검색 결과가 아닙니다.
const AT = /([가-힣A-Za-z0-9]{1,10})에서(?:는|도)?\s*/g;
const END = /(자|야지|야 ?[돼되해])$/;
const NOT_VERB = new Set(["피자", "과자", "의자", "모자", "상자", "여자", "남자", "부자"]);
export const TODO_METHOD = "place-rules-v1";

export function todoOf(value) {
  const text = value.trim().replace(/[.!? ]+$/, "");
  const place = [...text.matchAll(AT)].at(-1)?.[1];
  if (!place || !END.test(text) || NOT_VERB.has(text.split(" ").at(-1))) return null;
  return { place, text };
}

// 현재 살아 있는 발화만 입력받습니다. 교정본을 우선하되 원문·출처를 함께 돌려줍니다.
export function deriveTodos(lines, states = []) {
  const found = new Map(), saved = new Map(states.map((s) => [s.id, s]));
  for (const line of lines) {
    const displayText = line.displayText ?? line.editedText ?? line.asrText ?? line.text;
    if (!line.text || typeof displayText !== "string") continue;
    const todo = todoOf(displayText);
    if (!todo) continue;
    const id = createHash("sha256").update(JSON.stringify([todo.place, todo.text])).digest("hex").slice(0, 32);
    if (!found.has(id)) {
      const state = saved.get(id);
      found.set(id, { id, ...todo, status: state?.status ?? "pending", version: Number(state?.version ?? 0), sources: [] });
    }
    found.get(id).sources.push({ device: line.device, seq: line.seq, at: line.at, text: line.text, displayText,
      ...(line.participantId ? { participantId: line.participantId } : {}) });
  }
  return [...found.values()];
}

export const placeMatches = (place, name) => name.replace(/\s/g, "").includes(place);

function meters(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lng - a.lng) * rad / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

// 호출자가 보낸 관측 근거에 대한 판정입니다. 서버가 차량 기어·내비를 직접 관측한 뜻은 아닙니다.
export function arrivalBriefing(input, items, now = Date.now()) {
  const distance = meters(input.position, input.place), distanceMeters = Math.round(distance);
  const reason = !input.parked ? "not_parked" : now - input.observedAt > 60_000 ? "stale_position" : distance > 250 ? "outside_place" : null;
  return { eligible: reason === null, reason, source: input.source, observedAt: input.observedAt,
    place: input.place, distanceMeters, method: TODO_METHOD,
    items: reason === null ? items.filter((t) => t.status === "pending" && placeMatches(t.place, input.place.name)) : [] };
}
