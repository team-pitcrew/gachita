import test from "node:test";
import assert from "node:assert/strict";
import { ShortGeneration } from "./short-generation.js";

const plan = { momentId: "m", templateId: "car-sitcom-v1", generation: 1, planHash: "abc", audioReference: false };
function fixture(request, more = {}) {
  let stored = null;
  const model = new ShortGeneration({ code: "TEST12", generation: 1, canRead: () => true, savePending: (p) => { stored = p; }, request, ...more });
  model.catalog = { enabled: true }; model.plan = plan;
  return { model, stored: () => stored };
}
test("전송 응답이 사라지면 다시 연 화면도 같은 요청 키로만 확인한다", async () => {
  let body;
  const { model, stored } = fixture(async (method, path, data) => { body = data; throw Object.assign(new Error("offline"), { status: 0 }); });
  await assert.rejects(model.submit(true));
  assert.equal(stored().idempotencyKey, body.idempotencyKey);
  model.close();
  const resumed = fixture(async (method, path, data) => { assert.deepEqual(data, body); return { id: "job", state: "queued" }; }, { pending: stored() });
  await resumed.model.submit(true);
  assert.equal(resumed.stored(), null);
  assert.equal(resumed.model.items.length, 1);
});
test("버튼을 겹쳐 눌러도 POST는 한 번이며 명시적 동의 없이는 보내지 않는다", async () => {
  let resolve, calls = 0;
  const { model } = fixture(() => { calls++; return new Promise((r) => { resolve = r; }); });
  await assert.rejects(model.submit(false)); assert.equal(calls, 0);
  const first = model.submit(true); await model.submit(true); assert.equal(calls, 1);
  resolve({ id: "job" }); await first;
});
test("기능 비활성 중에도 계획을 읽지만 생성 요청은 전송하지 않는다", async () => {
  const requests = [];
  const { model } = fixture(async (method, path) => { requests.push(path); return plan; });
  model.catalog.enabled = false;
  await model.preview("car-sitcom-v1"); await assert.rejects(model.submit(true));
  assert.deepEqual(requests, ["/trips/TEST12/short-plans"]);
});
test("원문 변경 409는 이전 계획과 요청 키를 버리고 새 계획 확인을 요구한다", async () => {
  const { model, stored } = fixture(async () => { throw Object.assign(new Error("changed"), { status: 409 }); });
  await assert.rejects(model.submit(true)); assert.equal(model.plan, null); assert.equal(stored(), null);
});
test("화면을 닫거나 동의가 철회된 뒤 늦게 온 응답을 표시하지 않는다", async () => {
  let resolve;
  const { model } = fixture(() => new Promise((r) => { resolve = r; }));
  const wait = model.preview("car-sitcom-v1"); model.close(); resolve(plan);
  await assert.rejects(wait); assert.equal(model.plan, null);
});
test("다른 세대의 계획과 외부 다운로드 주소를 받지 않는다", async () => {
  const { model } = fixture(async () => ({ ...plan, generation: 2 }));
  await assert.rejects(model.preview("car-sitcom-v1"));
  assert.throws(() => model.filePath({ id: "j", state: "completed", result: { url: "https://example.com/video" } }));
  assert.equal(model.filePath({ id: "j", state: "completed", result: { url: "/api/trips/TEST12/short-generations/j/file" } }), "/api/trips/TEST12/short-generations/j/file");
});
test("요청 키를 저장하지 못하면 비용이 드는 요청을 보내지 않는다", async () => {
  let calls = 0;
  const { model } = fixture(async () => { calls++; }, { savePending: () => { throw new Error("storage denied"); } });
  await assert.rejects(model.submit(true)); assert.equal(calls, 0); assert.equal(model.pending, undefined);
});
