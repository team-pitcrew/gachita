// 화면 파일을 다른 출처의 하위 경로(CDN의 public/web/{커밋}/)에서 받아도 도는가(T180).
// 모듈과 CSS가 정적 파일을 루트 절대 주소("/chars/…", "/shared.js")로 가리키면 그 출처의 뿌리에서 찾다 실패한다 — 다시 생기면 여기서 막는다.
import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";

const here = (path) => new URL(path, import.meta.url);
const read = (path) => readFile(here(path), "utf8");
const names = async (dir) => (await readdir(here(dir), { withFileTypes: true })).filter((e) => e.isFile()).map((e) => `${dir}${e.name}`);
const all = [...(await names("./")), ...(await names("./demo/"))];
// 서비스 워커는 뺀다: 문서 출처에서 도는 파일이고, 받아 둘 목록(SHELL)을 루트 경로로 적은 뒤 화면 파일이 온 주소로 옮긴다(sw.test.mjs).
const modules = all.filter((f) => f.endsWith(".js") && f !== "./sw.js");
const styles = all.filter((f) => f.endsWith(".css"));
const folders = (await readdir(here("./"), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);

// 문서 출처 그대로 두는 것: API, 서비스 워커 등록, 화자 모델·실행기(서버가 따로 준다), 같은 출처로만 띄울 수 있는 화자 값 일꾼.
const SAME_ORIGIN = [/^\/api\//, /^\/sw\.js/, /^\/models\//, /^\/vendor\//, /^\/wespeaker-worker\.js$/];
const FILE = "js|mjs|css|json|webmanifest|svg|png|jpe?g|webp|gif|ico|woff2?|wasm|onnx|mp3|mp4|wav|webm";
// 따옴표·백틱 바로 뒤에서 /로 시작하는 글자열 가운데 (1) 웹 폴더의 하위 폴더로 시작하거나 (2) 파일 확장자로 끝나는 것.
const rooted = (text) => [...new Set([
  ...text.matchAll(new RegExp(`["'\`](/(?:${folders.join("|")})/[^"'\`\\s]*)`, "g")),
  ...text.matchAll(new RegExp(`["'\`](/[^"'\`\\s/][^"'\`\\s]*\\.(?:${FILE}))["'\`?#]`, "g")),
].map((m) => m[1]))].filter((path) => !SAME_ORIGIN.some((ok) => ok.test(path))).sort();

test("모듈은 정적 파일을 루트 절대 주소로 가리키지 않는다(상대 import, shared.js의 asset())", async () => {
  const found = [];
  for (const file of modules) for (const path of rooted(await read(file))) found.push(`${file}: ${path}`);
  assert.deepEqual(found, []);
});

test("검사가 실제로 잡는다: 루트 절대 그림·모듈 주소는 걸리고, 문서 출처에 두는 주소는 지나간다", () => {
  assert.deepEqual(rooted('img.src = "/chars/basic.png"; import x from "/shared.js"; const u = `/brief-icons/${id}.svg`; a("/demo/pcm-worklet.js")'),
    ["/brief-icons/${id}.svg", "/chars/basic.png", "/demo/pcm-worklet.js", "/shared.js"]);
  assert.deepEqual(rooted('fetch("/api/trips/x.json"); register("/sw.js"); m = `/models/${n}.onnx`; o = "/vendor/ort/1.27.0/"; new URL("/wespeaker-worker.js", o); location.hash = "/"; f.src = `/?view=${v}`; import y from "./shared.js"; asset("chars/basic.webp")'), []);
});

test("CSS의 url()은 그 파일 기준 상대 주소다", async () => {
  const found = [];
  for (const file of styles) for (const [, address] of (await read(file)).matchAll(/url\(\s*["']?([^"')\s]+)/g)) if (address.startsWith("/")) found.push(`${file}: ${address}`);
  assert.deepEqual(found, []);
});

test("모듈이 만든 그림 주소는 그 모듈이 온 자리를 따른다", async () => {
  const { asset } = await import("./shared.js");
  const { characterSource } = await import("./short-film.js");
  assert.equal(asset("maps/gangneung.jpg"), here("./maps/gangneung.jpg").href);
  assert.equal(characterSource("cap"), here("./chars/cap.webp").href);
  assert.equal(characterSource("없는 값"), here("./chars/basic.webp").href);
});

// app.js에서 시작해 정적 import를 따라간 모듈 전부(따옴표 종류와 관계없이).
async function graph(entry = "/app.js") {
  const seen = new Set(), todo = [entry];
  while (todo.length) {
    const path = todo.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    for (const [, spec] of (await read(`.${path}`)).matchAll(/^import [^;]*?from ["'](\.{1,2}\/[^"']+)["']/gm)) todo.push(new URL(spec, `https://x${path}`).pathname);
  }
  return seen;
}

test("index.html의 modulepreload는 app.js의 import 그래프와 같다(빠지면 한 단계 더 왕복하고, 남으면 안 쓰는 파일을 받는다)", async () => {
  const html = await read("./index.html");
  const preloaded = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]).sort();
  const wanted = [...(await graph())].filter((path) => path !== "/app.js").sort();
  assert.deepEqual(preloaded, wanted);
  assert.match(html, /<script type="module" src="\/app\.js">/);
});

test("캐릭터 그림: PNG 원본마다 같은 픽셀 크기의 WebP가 있고 화면(CSS)은 WebP를 쓴다", async () => {
  const pngs = (await names("./chars/")).filter((f) => f.endsWith(".png"));
  assert.equal(pngs.length, 20);
  for (const png of pngs) {
    const source = await readFile(here(png)), webp = await readFile(here(png.replace(/\.png$/, ".webp")));
    // PNG IHDR의 너비·높이, WebP VP8X(알파가 있는 확장 형식)의 캔버스 크기(값 − 1, 3바이트 리틀 엔디언)
    const size = [source.readUInt32BE(16), source.readUInt32BE(20)];
    assert.equal(webp.toString("latin1", 0, 4) + webp.toString("latin1", 8, 16), "RIFFWEBPVP8X", png);
    assert.deepEqual([webp.readUIntLE(24, 3) + 1, webp.readUIntLE(27, 3) + 1], size, png);
    assert.ok(webp[20] & 0x10, `${png}: 알파가 있어야 합니다`);
    assert.ok(webp.length * 4 < source.length, `${png}: WebP가 원본의 1/4보다 큽니다`);
  }
  const css = await read("./style.css");
  assert.doesNotMatch(css, /url\([^)]*chars\/[^)]*\.png/);
  assert.equal([...css.matchAll(/url\("chars\/[a-z-]+\.webp"\)/g)].length, 11);
});
