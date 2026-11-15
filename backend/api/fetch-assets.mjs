// 폰 웹이 브라우저에서 화자 값(wespeaker)을 만들 때 쓰는 모델과 실행기를 공식 릴리스에서 받아 확인한다(T170).
// 저장소에는 넣지 않는다(모델 25 MB, 실행기 13 MB). 이미지 빌드(Dockerfile)와 로컬 서버가 같이 쓴다:
//   node backend/api/fetch-assets.mjs            → backend/api/assets/ (서버가 /models/…, /vendor/ort/…로 준다)
//   node backend/api/fetch-assets.mjs /out       → 다른 폴더
// 이미 받은 것이 같은 값이면 다시 받지 않는다. 값이 다르면 아무것도 두지 않고 멈춘다.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 차 build.gradle(StrongVoice)과 같은 모델·같은 sha256. 가중치 CC BY 4.0, ONNX 변환은 sherpa-onnx(Apache-2.0).
const MODEL = {
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx",
  check: ["sha256", "e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012"],
  // 이름은 폰의 embedder 이름과 맞춘다(판이 바뀌면 이름을 바꿔 오래 캐시해도 안전하게)
  files: { "": ["models/wespeaker-resnet34-v1.onnx", "e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012"] },
};
// onnxruntime-web 1.27.0(MIT). npm 레지스트리가 tgz마다 공개하는 무결성 값(sha512)으로 확인하고, 폰이 부르는 세 파일만 꺼내 파일마다 sha256도 본다.
const ORT = {
  url: "https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.27.0.tgz",
  check: ["sha512", "ogDLsqIozHZwifPuN37OproAo0byX6t43/bP8GzeZWBWD6MOGExswFAx3up4NS/vvWBOg2u2PXomDt3rMmdQSg==", "base64"],
  files: {
    "package/dist/ort.wasm.min.mjs": ["vendor/ort/1.27.0/ort.wasm.min.mjs", "9608e98a3fba9716f0cbd0bca0c94808b71dae2e9265ca3fe742ddc393a53ebc"],
    "package/dist/ort-wasm-simd-threaded.mjs": ["vendor/ort/1.27.0/ort-wasm-simd-threaded.mjs", "0a1e718d99c41b22c21f2520ff4f9e883a6b5533856e398d21816ee8eb8185d3"],
    "package/dist/ort-wasm-simd-threaded.wasm": ["vendor/ort/1.27.0/ort-wasm-simd-threaded.wasm", "d1ab1b94b16a65b29d710d0b587b29e7bed336827577623913479b8afe8113e6"],
  },
};
export const SOURCES = [MODEL, ORT];

// 출처 표기(CC BY 4.0은 저작자·라이선스·출처를 밝혀야 한다). /models/NOTICE.txt, /vendor/ort/1.27.0/NOTICE.txt로 함께 준다.
export const NOTICE = {
  "models/NOTICE.txt": `wespeaker-resnet34-v1.onnx
- 모델: WeSpeaker ResNet34-LM (VoxCeleb), WeNet Open Source Community — https://github.com/wenet-e2e/wespeaker
- 가중치 라이선스: CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/
- ONNX 파일: k2-fsa/sherpa-onnx 릴리스 'speaker-recongition-models'의 wespeaker_en_voxceleb_resnet34_LM.onnx(바꾸지 않음) — ${MODEL.url}
- sha256: ${MODEL.check[1]}
`,
  "vendor/ort/1.27.0/NOTICE.txt": `onnxruntime-web 1.27.0 (ort.wasm.min.mjs, ort-wasm-simd-threaded.mjs, ort-wasm-simd-threaded.wasm)
- Copyright (c) Microsoft Corporation. MIT License — https://github.com/microsoft/onnxruntime/blob/main/LICENSE
- 출처: ${ORT.url} (npm integrity ${ORT.check[0]}-${ORT.check[1]}, 바꾸지 않음)
`,
};

const digest = (buf, [algo, want, enc = "hex"]) => createHash(algo).update(buf).digest(enc) === want;

async function fetchChecked(src) {
  const res = await fetch(src.url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`${src.url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!digest(buf, src.check)) throw new Error(`${src.url}: ${src.check[0]} 값이 다릅니다`);
  return buf;
}

export async function fetchAssets(out) {
  const marker = join(out, ".sources.json");
  const want = JSON.stringify(SOURCES.map((s) => [s.url, s.check[1], s.files]));
  if ((await readFile(marker, "utf8").catch(() => "")) === want) return false;
  const work = await mkdtemp(join(tmpdir(), "gachita-assets-"));
  try {
    for (const src of SOURCES) {
      const buf = await fetchChecked(src);
      for (const [member, [to, sha256]] of Object.entries(src.files)) {
        let data = buf;
        if (member) {
          // tgz 안의 파일: 시스템 tar로 그 파일만 꺼낸다(의존성 없이)
          const tgz = join(work, "src.tgz");
          await writeFile(tgz, buf);
          execFileSync("tar", ["-xzf", tgz, "-C", work, member]);
          data = await readFile(join(work, member));
        }
        if (!digest(data, ["sha256", sha256])) throw new Error(`${to}: sha256 값이 다릅니다`);
        await mkdir(dirname(join(work, "out", to)), { recursive: true });
        await writeFile(join(work, "out", to), data);
      }
    }
    for (const [to, text] of Object.entries(NOTICE)) await writeFile(join(work, "out", to), text);
    await writeFile(join(work, "out", ".sources.json"), want);
    await writeFile(join(work, "out", ".gitignore"), "*\n");
    // 다 받고 확인한 뒤에만 바꿔 둔다(중간에 실패하면 옛것이 그대로)
    await rm(out, { recursive: true, force: true });
    await mkdir(dirname(out), { recursive: true });
    await rename(join(work, "out"), out);
    return true;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? fileURLToPath(new URL("./assets", import.meta.url));
  const fetched = await fetchAssets(out);
  console.log(fetched ? `받음: ${out}` : `이미 같은 것이 있음: ${out}`);
}
