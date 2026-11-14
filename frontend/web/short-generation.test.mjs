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

test("스타일과 원음 설정을 바꾸어도 사용자가 고른 장면을 계획에 보낸다", async () => {
  const requests = [];
  const { model } = fixture(async (_method, _path, body) => { requests.push(body); return { ...plan, ...body }; });
  await model.preview("car-sitcom-v1", false, "selected-scene");
  await model.preview("travel-postcard-v1", true, "selected-scene");
  assert.deepEqual(requests, [
    { templateId: "car-sitcom-v1", audioReference: false, momentId: "selected-scene" },
    { templateId: "travel-postcard-v1", audioReference: true, momentId: "selected-scene" },
  ]);
  assert.equal(model.plan.momentId, "selected-scene");
});

test("서버가 다른 장면을 돌려주면 그 계획으로 생성할 수 없다", async () => {
  let calls = 0;
  const { model } = fixture(async () => { calls++; return plan; });
  await assert.rejects(model.preview("car-sitcom-v1", false, "different-scene"), /선택한 장면/);
  assert.equal(model.plan, null);
  await assert.rejects(model.submit(true), /장면 구성을 먼저/);
  assert.equal(calls, 1);
});

test("응답을 잃은 요청은 새 장면 선택으로 바꾸지 않고 원래 동의 본문으로 재전송한다", async () => {
  const pending = { momentId: "original", templateId: "car-sitcom-v1", audioReference: true, generation: 1, planHash: "original-hash", externalGenerationConsent: true, idempotencyKey: "same-key" };
  const requests = [];
  const { model } = fixture(async (_method, _path, body) => { requests.push(body); return { id: "original-job", state: "queued" }; }, { pending });
  await assert.rejects(model.preview("travel-postcard-v1", false, "new-scene"));
  assert.equal(model.pending, pending);
  await model.submit(true);
  assert.deepEqual(requests, [pending]);
});

test("차량과 웹의 공용 보관함은 같은 API와 출처별 인증 파일 주소를 쓴다", async () => {
  const requests = [];
  const { model } = fixture(async (_method, path) => { requests.push(path); return { generation: 1, items: [{ id: 'local', origin: 'local-render', state: 'completed' }] }; });
  await model.refresh(); assert.deepEqual(requests, ['/trips/TEST12/short-assets']);
  assert.equal(model.filePath({ id: 'local', origin: 'local-render', state: 'completed', result: { url: '/api/trips/TEST12/short-assets/local/file' } }), '/api/trips/TEST12/short-assets/local/file');
  assert.throws(() => model.filePath({ id: 'local', origin: 'local-render', state: 'completed', result: { url: '/api/trips/OTHER/short-assets/local/file' } }));
});
