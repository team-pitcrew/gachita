import assert from "node:assert/strict";
import test from "node:test";
import { createShares } from "./shares.js";

// 목록의 표시 내용과 클릭만 검증한다. 실제 캔버스·레이아웃·파일 저장 시험은 브라우저에서 한다.
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  addEventListener() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
}
const elements = (el) => [el, ...el.children.filter((child) => child instanceof Element).flatMap(elements)];
const content = (el) => el instanceof Element ? el.children.map(content).join(" ") : String(el);

test("다운로드 권한이 사라지면 취소를 무시한 옛 목록 응답도 공유 내용을 되살리지 않는다", async (t) => {
  const body = new Element("body");
  const originals = new Map(["document", "addEventListener"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  globalThis.document = { body, createElement: (tag) => new Element(tag), createElementNS: (ns, tag) => Object.assign(new Element(tag), { namespaceURI: ns }) };
  globalThis.addEventListener = () => {};
  let shares;
  t.after(() => {
    shares?.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const timers = new Map();
  let nextTimer = 0;
  t.mock.method(globalThis, "setTimeout", (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; });
  t.mock.method(globalThis, "clearTimeout", (id) => timers.delete(id));
  t.mock.method(globalThis, "setInterval", () => 0);
  t.mock.method(globalThis, "clearInterval", () => {});
  const item = { id: "synthetic-share", direction: "received", sender: { name: "합성 동승자" }, label: "합성 장면", caption: "권한 확인 뒤 숨길 합성 문구", at: Date.now() - 30 * 86400_000, expiresAt: null };
  const response = () => new Response(JSON.stringify({ items: [item] }));
  let requests = 0, release, oldSignal;
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    requests++;
    if (requests === 1) return response();
    // AbortSignal을 의도적으로 무시한다. 취소 전에 이미 도착한 응답도 늦게 처리될 수 있다.
    if (requests === 2) { oldSignal = signal; return new Promise((resolve) => { release = () => resolve(response()); }); }
    if (requests === 3) return new Response(JSON.stringify({ error: "프로필 권한 없음" }), { status: 401 });
    assert.fail("권한 확인 실패 뒤 자동으로 목록을 다시 읽으면 안 됨");
  });
  let profileChecks = 0;
  shares = createShares({ getProfile: () => ({ id: "synthetic-profile" }), getProfileToken: () => "synthetic-token", getTrip: () => null, getParticipant: () => null, getParticipantToken: () => null, onProfile: () => { profileChecks++; } });
  const button = (text) => elements(body).find((el) => el.tag === "button" && content(el) === text);
  await shares.openList();
  assert.ok(content(body).includes(item.caption));
  const oldRead = button("새로 고침").onclick();
  await elements(body).find((el) => el.attrs["aria-label"] === "공유 이미지 다운로드").onclick();
  assert.ok(!content(body).includes(item.caption), "다운로드 401 뒤 문구를 지움");
  release();
  await oldRead;
  assert.ok(!content(body).includes(item.label), "늦은 200 뒤에도 카드를 복원하지 않음");
  assert.ok(!content(body).includes(item.caption), "늦은 200 뒤에도 문구를 복원하지 않음");
  assert.equal(oldSignal.aborted, true, "이전 목록 요청도 취소함");
  assert.equal(requests, 3);
  assert.equal(timers.size, 0, "늦은 응답이 폴링을 다시 예약하지 않음");
  button("프로필 확인").onclick();
  assert.equal(profileChecks, 1);
  assert.equal(body.children[0].open, false);
  assert.equal(content(body), "");
});
