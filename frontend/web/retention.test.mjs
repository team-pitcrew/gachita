import assert from "node:assert/strict";
import test from "node:test";
import { createRecords } from "./records.js";
import { createCaptions } from "./captions.js";
import { createShares } from "./shares.js";

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  addEventListener() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  querySelector() { return null; }
  click() { this.onclick?.(); }
  remove() {}
}
const elements = (el) => [el, ...el.children.filter((child) => child instanceof Element).flatMap(elements)];
const content = (el) => el instanceof Element ? el.children.map(content).join(" ") : String(el);
function screen(t) {
  const body = new Element("body"), toast = new Element("aside"), downloads = [];
  const originals = new Map(["document", "addEventListener"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  globalThis.document = {
    body, getElementById: () => toast,
    createElement(tag) {
      const el = new Element(tag);
      if (tag === "canvas") {
        el.getContext = () => new Proxy({ measureText: (text) => ({ width: text.length * 10 }) }, { get: (target, key) => target[key] ?? (() => {}) });
        el.toBlob = (done) => done(new Blob(["test card"], { type: "image/png" }));
      }
      if (tag === "a") el.click = () => downloads.push(el.download);
      return el;
    },
    createElementNS: (ns, tag) => Object.assign(new Element(tag), { namespaceURI: ns }),
  };
  globalThis.addEventListener = () => {};
  for (const name of ["setTimeout", "setInterval", "clearTimeout", "clearInterval"]) t.mock.method(globalThis, name, () => 0);
  t.after(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return { body, downloads, button: (text) => elements(body).find((el) => el.tag === "button" && content(el) === text) };
}
const oldTrip = () => ({ code: "OLD123", createdAt: Date.now() - 30 * 86400_000, generation: 1 });

test("오래된 여행에서도 장면을 고르고 저장하며 철회한 뒤 후보를 걷는다", async (t) => {
  const ui = screen(t), trip = oldTrip(), me = { id: "rider", consent: true }, calls = [];
  const candidate = { at: trip.createdAt + 2000, from: trip.createdAt + 1000, to: trip.createdAt + 16000, why: "대화 구간", lines: [{ text: "남길 대화" }] };
  const records = createRecords({ getTrip: () => trip, getParticipant: () => me, getParticipantToken: () => "token", onSaved: async () => {},
    participantRequest: async (method, path, body) => { calls.push({ method, path, body }); return { items: [candidate] }; } });
  t.after(() => records.close());
  await records.openScenes();
  assert.ok(content(ui.body).includes("남길 대화"));
  await elements(ui.body).find((el) => el.tag === "form").onsubmit({ preventDefault() {} });
  assert.equal(calls[1].path, "/moments");
  assert.equal(calls[1].body.from, candidate.from);
  await records.openScenes();
  me.consent = false; records.sync();
  assert.equal(ui.body.children[0].open, false);
  assert.equal(content(ui.body), "");
});

test("오래된 여행의 자막을 편집하고 저장하되 동의 철회 뒤에는 초안을 지운다", async (t) => {
  const ui = screen(t), trip = oldTrip(), me = { id: "rider", consent: true }, calls = [];
  const row = { device: "car", seq: 1, at: trip.createdAt, text: "원문", editVersion: 0 };
  const captions = createCaptions({ getTrip: () => trip, getParticipant: () => me, refreshTrip: async () => {},
    request: async (_code, method, path, body) => { calls.push({ method, path, body }); return method === "GET" ? { generation: 1, utterances: [row] } : { generation: 1, utterance: { ...row, editedText: body.text, editVersion: 1 } }; } });
  t.after(() => captions.close(true));
  await captions.open();
  ui.button("자막 고치기").onclick();
  elements(ui.body).find((el) => el.tag === "textarea").oninput({ target: { value: "고친 자막" } });
  await ui.button("변경 저장").onclick();
  assert.equal(calls[1].path, "/captions/car/1");
  assert.equal(calls[1].body.text, "고친 자막");
  assert.ok(content(ui.body).includes("고친 자막"));
  me.consent = false; captions.sync();
  assert.equal(ui.body.children[0].open, false);
  assert.equal(content(ui.body), "");
});

for (const expiry of [null, undefined]) {
  test(`기한 ${expiry === null ? "null" : "생략"} 공유도 오래된 장면을 읽고 재확인한 뒤 내려받는다`, async (t) => {
    const ui = screen(t), item = { id: "share", direction: "received", sender: { name: "동승자" }, at: oldTrip().createdAt, label: "오래된 장면", ...(expiry === null ? { expiresAt: null } : {}) };
    let reads = 0;
    t.mock.method(globalThis, "fetch", async () => { reads++; return Response.json({ items: [item] }); });
    t.mock.method(URL, "createObjectURL", () => "blob:test");
    t.mock.method(URL, "revokeObjectURL", () => {});
    const shares = createShares({ getProfile: () => ({ id: "me" }), getProfileToken: () => "profile-token" });
    t.after(() => shares.close());
    await shares.openList();
    assert.ok(content(ui.body).includes(item.label));
    assert.ok(!content(ui.body).includes("1970"));
    await elements(ui.body).find((el) => el.attrs["aria-label"] === "공유 이미지 다운로드").onclick();
    assert.equal(reads, 3, "목록과 변환 전후 권한을 모두 확인함");
    assert.equal(ui.downloads.length, 1);
    assert.match(ui.downloads[0], /\.png$/);
  });
}
