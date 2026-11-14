import test from "node:test";
import assert from "node:assert/strict";
import { planShort, shotPrompt } from "./short-templates.js";
import { subtitles } from "./short-render.js";
import { higgsfield } from "./providers/higgsfield.js";
import { downloadVideo } from "./providers/short-media.js";
const source = () => ({
  generation: 1,
  title: "우리 여행",
  cast: [
    { participantId: "a", name: "가", character: "cap", seat: "ROW_1_LEFT" },
    {
      participantId: "b",
      name: "나",
      character: "glasses-small",
      seat: "ROW_1_RIGHT",
    },
  ],
  scenes: [
    {
      momentId: "m",
      seconds: 30.319,
      at: 1,
      label: "휴게소 농담",
      cues: [
        {
          start: 1,
          end: 2,
          text: "안녕",
          participantId: "a",
          device: "car",
          seq: 1,
          editVersion: 0,
        },
        {
          start: 4,
          end: 6,
          text: "하하하",
          participantId: "b",
          device: "car",
          seq: 2,
          editVersion: 0,
        },
      ],
    },
  ],
});
test("대화와 캐릭터는 고정하고 15~45초를 모델이 받는 4~30초 단위로 나눕니다", () => {
  for (const seconds of [15, 30.319, 45]) {
    const s = source();
    s.scenes[0].seconds = seconds;
    const p = planShort(s);
    assert.equal(p.shots[0].start, 0);
    assert.equal(p.shots.at(-1).end, seconds);
    assert.ok(
      p.shots.every(
        (x) => x.generationSeconds >= 4 && x.generationSeconds <= 30,
      ),
    );
    assert.deepEqual(
      p.cast.map((x) => x.character),
      ["cap", "glasses-small"],
    );
    assert.equal(p.planHash, planShort(s, p).planHash);
    assert.match(shotPrompt(p, p.shots[0]), /exactly TWO arms/);
    assert.doesNotMatch(shotPrompt(p, p.shots[0]), /안녕|휴게소 농담/);
  }
  const s = source();
  s.scenes[0].seconds = 46;
  assert.throws(
    () => planShort(s),
    (e) => e.status === 409,
  );
});
test("미확인 화자를 실명으로 추측하지 않고 수정된 자막은 새 제작 계획이 됩니다", () => {
  const s = source();
  s.scenes[0].cues.forEach((x) => (x.participantId = null));
  const p = planShort(s);
  assert.deepEqual(
    p.cast.map((x) => x.participantId),
    [null, null],
  );
  assert.deepEqual(
    p.cast.map((x) => x.character),
    ["basic", "basic-small"],
  );
  assert.ok(p.cues.every((x) => x.slot === null));
  const before = p.planHash;
  s.scenes[0].cues[0].text = "다른 대화";
  assert.notEqual(planShort(s).planHash, before);
  assert.ok(
    planShort(s, { audioReference: true }).externalData.includes("장면별 원음"),
  );
  assert.ok(!p.externalData.includes("장면별 원음"));
});
test("한국어 자막은 원문을 모두 유지하고 ASS 태그를 실행하지 않습니다", () => {
  const p = planShort(source());
  p.cues[0].text = "{\\pos(0,0)}" + "가".repeat(110);
  const ass = subtitles(p);
  assert.doesNotMatch(ass, /\{\\pos/);
  assert.equal((ass.match(/가/g) || []).length, 113);
  assert.match(ass, /Noto Sans CJK KR/);
});
const request = {
  id: "request",
  statusUrl: "https://api.higgsfield.ai/requests/request/status",
  cancelUrl: "https://api.higgsfield.ai/requests/request/cancel",
};
test("힉스필드 요청은 서버 인증을 쓰며 상태·취소·삭제를 같은 요청에 연결합니다", async () => {
  const seen = [];
  const replies = [
    new Response(
      JSON.stringify({
        request_id: "request",
        status_url: request.statusUrl,
        cancel_url: request.cancelUrl,
      }),
      { status: 202 },
    ),
    Response.json({
      status: "completed",
      request_id: "request",
      video: { url: "https://cdn.higgsfield.ai/result.mp4" },
    }),
    new Response(null, { status: 202 }),
    Response.json({ status: "deleted" }),
  ];
  const h = higgsfield({
    credentials: "id:secret",
    fetcher: async (u, o) => {
      seen.push([u, o]);
      return replies.shift();
    },
  });
  assert.deepEqual(
    await h.submit("bytedance/seedance-2.5/reference-to-video", {
      duration: 8,
    }),
    request,
  );
  assert.equal((await h.status(request)).status, "completed");
  await h.cancel(request);
  await h.remove(request);
  assert.ok(
    seen.every(
      ([, o]) =>
        o.headers.Authorization === "Key id:secret" && o.redirect === "error",
    ),
  );
  assert.deepEqual(
    seen.map(([, o]) => o.method),
    ["POST", "GET", "POST", "DELETE"],
  );
});
test("제출 응답이 불명확하면 자동 재제출하지 않도록 구분하고 외부 상태 URL에 키를 보내지 않습니다", async () => {
  for (const response of [
    () => {
      throw Error("timeout");
    },
    () => new Response("broken", { status: 202 }),
    () =>
      Response.json({
        request_id: "x",
        status_url: "https://attacker.invalid/requests/x",
        cancel_url: request.cancelUrl,
      }),
  ]) {
    const h = higgsfield({ fetcher: async () => response() });
    await assert.rejects(h.submit("model", {}), (e) => e.uncertain === true);
  }
  let calls = 0;
  const h = higgsfield({
    fetcher: async () => {
      calls++;
      return Response.json({});
    },
  });
  await assert.rejects(
    h.status({ ...request, statusUrl: "https://attacker.invalid/requests/x" }),
  );
  assert.equal(calls, 0);
});
test("완료 파일은 승인한 공개 HTTPS 호스트의 MP4만 받습니다", async () => {
  let fetched = 0;
  const mp4 = Buffer.from("0000ftypisom0000");
  const options = {
    hosts: ["cdn.example.com"],
    resolver: async () => [{ address: "1.1.1.1" }],
    fetcher: async (u, o) => {
      fetched++;
      assert.equal(o.redirect, "error");
      return new Response(mp4);
    },
  };
  assert.deepEqual(
    await downloadVideo("https://cdn.example.com/a.mp4", options),
    mp4,
  );
  for (const u of [
    "http://cdn.example.com/a",
    "https://user:pass@cdn.example.com/a",
    "https://127.0.0.1/a",
    "https://other.example/a",
  ])
    await assert.rejects(downloadVideo(u, options));
  await assert.rejects(
    downloadVideo("https://cdn.example.com/a", {
      ...options,
      resolver: async () => [{ address: "169.254.169.254" }],
    }),
  );
  assert.equal(fetched, 1);
  await assert.rejects(
    downloadVideo("https://cdn.example.com/a", {
      ...options,
      fetcher: async () => new Response("not mp4"),
    }),
  );
});
