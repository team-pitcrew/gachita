#!/usr/bin/env node
// 확장 API 여정. 기존 e2e.mjs는 그대로 두고, T38/T43/T75/T76 배포를 확인할 때 별도로 실행한다.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

// 음성 내용/가족 목소리의 정확도 시험이 아니다. 등록·대조 계약을 위한 합성 파형이다.
export function wave(frequency, seconds) {
  const samples = Math.round(seconds * 16000);
  const out = Buffer.alloc(44 + samples * 2);
  out.write("RIFF"); out.writeUInt32LE(out.length - 8, 4); out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16000, 24); out.writeUInt32LE(32000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write("data", 36); out.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const t = i / 16000;
    const value = .6 * Math.sin(2 * Math.PI * frequency * t + Math.sin(t * 3)) + .25 * Math.sin(4 * Math.PI * frequency * t) + .1 * Math.sin(6 * Math.PI * frequency * t + 1);
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 20000), 44 + i * 2);
  }
  return out;
}

export async function runJourney(base, { asr, storage, clip = wave(210, 25), waitMs = 30000, onStep = () => {} } = {}) {
  const url = new URL(base);
  assert.ok(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, "토큰/쿼리 없는 HTTP(S) 서버 주소가 필요합니다");
  assert.ok(["required", "unverified"].includes(asr), "asr=required 또는 unverified를 명시하세요");
  assert.ok(["fixture", "s3"].includes(storage), "storage=fixture 또는 s3를 명시하세요");
  base = base.replace(/\/+$/, "");
  const report = { status: "running", scope: "API HTTP contract; bucket/provider internals are not inspected", storage, asr: "unverified", steps: [], cleanup: { failures: [], retainedTrips: [] }, unverified: ["Google 브라우저 로그인", "폰 QR/차 카메라", "실차·화면 재생", "실제 목소리의 화자·전사 정확도", "48시간 경과 삭제", "버킷 버전·삭제 표시(별도 저장소 확인 필요)"] };
  const profiles = [], riders = [], moments = [];
  let trip, t, generation, stage = "시작";
  const request = async (method, path, expected, { body, raw, token } = {}) => {
    const res = await fetch(base + path, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(raw ? { "content-type": "audio/wav" } : body ? { "content-type": "application/json" } : {}) },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), signal: AbortSignal.timeout(15000),
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    // 오류 본문에는 서비스/제공자의 내부 정보가 있을 수 있으므로 상태만 보고한다.
    assert.ok([expected].flat().includes(res.status), `${method} ${path.split("?")[0].replace(/\/api\/trips\/[^/]+/, "/api/trips/:trip")}: HTTP ${expected} 기대, ${res.status} 받음${res.status === 503 ? " (필요한 서비스가 준비되지 않음)" : ""}`);
    let json = null;
    if (res.headers.get("content-type")?.includes("application/json") && bytes.length) {
      try { json = JSON.parse(bytes); } catch { throw new Error("서버 JSON 응답을 읽을 수 없음 (본문 생략)"); }
    }
    return { status: res.status, bytes, headers: res.headers, json };
  };
  const step = async (name, fn) => { stage = name; await fn(); report.steps.push(name); onStep(name); };
  const poll = async (fn, predicate, label) => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const value = await fn();
      if (predicate(value)) return value;
      assert.ok(Date.now() < deadline, `${label}: ${waitMs}ms 안에 확인되지 않음`);
      await sleep(200);
    }
  };
  try {
    await step("프로필·여행·서로 다른 참가자", async () => {
      await request("GET", "/healthz", 200);
      for (const name of ["E2E 지우", "E2E 하늘"]) profiles.push((await request("POST", "/api/profiles", 201, { body: { name, consentDefault: false } })).json);
      trip = (await request("POST", "/api/trips", 201, { body: { title: "E2E 확장 여정" } })).json;
      t = `/api/trips/${trip.code}`; generation = trip.generation;
      for (let i = 0; i < 2; i++) riders.push((await request("POST", `${t}/participants`, 201, { token: profiles[i].token, body: { seat: i ? "ROW_2_LEFT" : "ROW_1_LEFT", consent: false } })).json);
    });
    await step("본인만 동의 ON·다른 참가자 토큰 거절", async () => {
      await request("PATCH", `${t}/participants/${riders[0].id}`, 401, { body: { consent: true } });
      await request("PATCH", `${t}/participants/${riders[0].id}`, 403, { token: riders[1].token, body: { consent: true } });
      for (const p of riders) await request("PATCH", `${t}/participants/${p.id}`, 200, { token: p.token, body: { consent: true } });
      assert.equal((await request("PATCH", t, 200, { body: { status: "driving" } })).json.recording, true);
    });
    const said = ["서와야 바다 봐", "정말 바다가 보여", "창밖에 파도가 보여", "도착하면 같이 걷자", "오늘 하늘이 맑아", "이 장면을 남기자"];
    const items = said.map((text, i) => ({ seq: i + 1, at: trip.createdAt + 1000 + i * 4000, text, seatArea: i % 2 ? "ROW_2_LEFT" : "ROW_1_LEFT", generation }));
    await step("발화 업로드·멱등·기기 소유", async () => {
      const body = { device: "journey-car", items };
      for (let i = 0; i < 2; i++) assert.equal((await request("POST", `${t}/utterances`, 200, { token: riders[0].token, body })).json.lastSeq, 6);
      await request("POST", `${t}/utterances`, 403, { token: riders[1].token, body });
      assert.equal((await request("GET", `${t}/transcript`, 200, { token: riders[0].token })).json.utterances.length, 6);
    });
    await step("목소리 등록·실제 대조→프로필 피드", async () => {
      for (let i = 0; i < 2; i++) await request("POST", "/api/profiles/me/voice", 200, { token: profiles[i].token, raw: wave(i ? 340 : 210, 3) });
      const matched = (await request("POST", `${t}/voice-match?row=1&seatArea=ROW_1_LEFT&device=journey-car&seq=1`, 200, { token: riders[0].token, raw: wave(210, 1.5) })).json;
      assert.equal(matched.profileId, profiles[0].id); assert.equal(matched.applied, true);
      const feeds = await Promise.all(profiles.map(async (p) => (await request("GET", "/api/profiles/me/feed", 200, { token: p.token })).json.items));
      assert.ok(feeds[0].some((u) => u.kind === "utterance" && u.text === said[0]));
      assert.ok(feeds[1].every((u) => u.kind !== "utterance"), "다른 프로필 피드에 발화가 섞이면 안 됨");
    });
    let choice;
    await step("추천 후보→사람이 선택→내 앨범", async () => {
      await request("GET", `${t}/scene-suggestions`, 401);
      const candidates = (await request("GET", `${t}/scene-suggestions`, 200, { token: riders[0].token })).json.items;
      assert.ok(candidates.length > 0, "발화가 모인 구간의 후보 없음");
      choice = candidates[0];
      const m = (await request("POST", `${t}/moments`, 201, { token: riders[0].token, body: { at: choice.at, from: choice.from, to: choice.to, label: "E2E 선택 장면" } })).json;
      moments.push(m);
      assert.ok((await request("GET", `${t}/scene-suggestions`, 200, { token: riders[0].token })).json.items.every((c) => c.to < choice.from || c.from > choice.to));
      assert.ok((await request("GET", "/api/profiles/me/feed", 200, { token: profiles[0].token })).json.items.some((x) => x.kind === "moment" && x.id === m.id));
      assert.ok((await request("GET", "/api/profiles/me/feed", 200, { token: profiles[1].token })).json.items.every((x) => x.id !== m.id));
    });
    const upload = (m, token = riders[0].token) => request("POST", `${t}/recordings?moment=${m.id}&generation=${generation}&from=${choice.from}`, [200, 201], { token, raw: clip });
    await step("클립 업로드→같은 바이트 재생·인증", async () => {
      assert.equal((await upload(moments[0])).status, 201);
      assert.equal((await upload(moments[0])).status, 200);
      await request("GET", `${t}/recordings/${moments[0].id}`, 401);
      const result = await request("GET", `${t}/recordings/${moments[0].id}`, 200, { token: riders[0].token });
      assert.ok(result.bytes.equals(clip), "내려받은 클립 바이트가 올린 것과 다름");
      assert.match(result.headers.get("cache-control"), /no-store/);
    });
    await step("숏폼 구성·원문과 재전사 결과", async () => {
      const get = async () => (await request("GET", `${t}/shortform`, 200, { token: riders[0].token })).json;
      let form = await get();
      assert.equal(form.scenes.length, 1); assert.equal(form.scenes[0].momentId, moments[0].id);
      assert.ok(form.scenes[0].clip === `${t}/recordings/${moments[0].id}`, "숏폼 클립 주소가 저장한 장면과 다름");
      assert.equal(form.scenes[0].cues[0].participantId, riders[0].id);
      assert.ok(form.scenes[0].cues.every((c) => c.start >= 0 && c.end > c.start && c.end <= form.scenes[0].seconds));
      if (asr === "required") {
        const transcript = await poll(async () => (await request("GET", `${t}/transcript`, 200, { token: riders[0].token })).json, (r) => r.utterances.some((u) => u.asrText), "ASR 결과(미설정·접속 실패도 성공으로 간주하지 않음)");
        form = await get();
        assert.ok(form.scenes[0].cues.some((c) => transcript.utterances.some((u) => u.asrText && c.raw === u.text && c.text === u.asrText)));
        report.asr = "result-observed";
      } else report.unverified.push("ASR 활성화·성공(이 실행에서 요구하지 않음)");
      report.shortformScenes = form.scenes.length;
    });
    await step("내 글·클립 삭제와 재업로드 차단", async () => {
      // 삭제 전후를 (device, seq)로 대조한다: riders[0]의 화자로 붙은 첫 발화만 사라지고, 나머지 다섯은 순번·원문이 그대로이며
      // 삭제 전에 있던 재전사문을 잃지 않아야 한다(재전사는 뒤에서 계속 돌아 삭제 뒤에 새로 붙을 수는 있다).
      const transcript = async () => (await request("GET", `${t}/transcript`, 200, { token: riders[1].token })).json.utterances;
      const key = (u) => `${u.device}:${u.seq}`;
      const before = await transcript();
      assert.equal(before.length, said.length, "삭제 전 발화 수");
      assert.equal((await request("DELETE", `${t}/utterances`, 200, { token: riders[0].token })).json.deleted, 1, "자기 이름이 붙은 발화 하나만 지움");
      const after = await transcript();
      const kept = before.filter((u) => !(u.device === "journey-car" && u.seq === 1));
      assert.deepEqual(after.map((u) => [key(u), u.text]), kept.map((u) => [key(u), u.text]), "나머지 다섯은 순번·원문이 그대로");
      for (const u of kept.filter((x) => x.asrText)) assert.equal(after.find((x) => key(x) === key(u)).asrText, u.asrText, `${key(u)}의 재전사문이 남음`);
      await request("DELETE", `${t}/recordings/${moments[0].id}`, 204, { token: riders[1].token });
      await request("GET", `${t}/recordings/${moments[0].id}`, 404, { token: riders[0].token });
      await request("POST", `${t}/recordings?moment=${moments[0].id}&generation=${generation}&from=${choice.from}`, 409, { token: riders[0].token, raw: clip });
    });
    await step("동의 철회→글·클립 접근 차단·옛 세대 거절", async () => {
      const m = (await request("POST", `${t}/moments`, 201, { token: riders[0].token, body: { at: choice.at, from: choice.from, to: choice.to, label: "E2E 철회 장면" } })).json;
      moments.push(m); await upload(m);
      await request("PATCH", `${t}/participants/${riders[1].id}`, 200, { body: { consent: false } });
      const now = (await request("GET", t, 200)).json;
      assert.equal(now.recording, false); assert.ok(now.generation > generation);
      await request("GET", `${t}/recordings/${m.id}`, 403, { token: riders[1].token });
      await request("GET", `${t}/recordings/${m.id}`, 404, { token: riders[0].token });
      assert.equal((await request("GET", `${t}/transcript`, 200, { token: riders[0].token })).json.utterances.length, 0);
      await request("PATCH", `${t}/participants/${riders[1].id}`, 200, { token: riders[1].token, body: { consent: true } });
      await request("POST", `${t}/recordings?moment=${m.id}&generation=${generation}&from=${choice.from}`, 409, { token: riders[0].token, raw: clip });
    });
    report.status = asr === "required" ? "passed" : "partial";
  } catch (error) {
    report.status = "failed"; report.failure = { stage, message: error.message };
  } finally {
    // 어느 단계에서 실패해도 이미 만든 클립·동의·프로필을 정리한다. 여행 DELETE는 API에 없다.
    const clean = async (label, fn) => { try { await fn(); } catch (error) { report.cleanup.failures.push({ label, message: error.message }); } };
    if (t) {
      for (const m of moments) await clean("클립", () => request("DELETE", `${t}/recordings/${m.id}`, [204, 404], { token: riders[0]?.token }));
      for (const p of riders) await clean("동의 OFF", () => request("PATCH", `${t}/participants/${p.id}`, 200, { body: { consent: false } }));
      await clean("여행 종료", () => request("PATCH", t, 200, { body: { status: "ended" } }));
      report.cleanup.retainedTrips.push({ title: "E2E 확장 여정", count: 1, reason: "여행 DELETE API 없음: 빈 시험 여행/장면 메타데이터는 48시간 만료 또는 ops clean-e2e로 정리" });
    }
    for (const p of profiles) await clean("프로필", () => request("DELETE", "/api/profiles/me", 204, { token: p.token }));
    if (report.cleanup.failures.length) report.status = "failed";
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [base, ...args] = process.argv.slice(2);
    const options = Object.fromEntries(args.map((arg) => { const m = /^--(asr|storage|wav)=(.+)$/.exec(arg); assert.ok(m, "알 수 없는 인자"); return [m[1], m[2]]; }));
    if (options.wav) options.clip = await readFile(options.wav);
    const result = await runJourney(base, { ...options, onStep: (name) => console.error(`✓ ${name}`) });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "passed" ? 0 : result.status === "partial" ? 3 : 1;
  } catch (error) { console.error(error.message); console.error("node .github/scripts/journey-e2e.mjs <URL> --storage=fixture|s3 --asr=required|unverified [--wav=선택한_클립.wav]"); process.exitCode = 2; }
}
