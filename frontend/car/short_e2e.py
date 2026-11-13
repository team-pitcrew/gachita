"""쇼츠 재생 E2E(T43 차 몫): 주차 중 쇼츠 탭에서 장면 클립·자막·말한 사람을 보이며, 주행 중에는 닫는다.

준비: capture_e2e.py와 같다(make run 또는 GACHITA_PORT의 서버, -grpc 8556 -grpc-use-token -audio none으로 켠 에뮬레이터,
      adb forward tcp:8088 tcp:8088, ./gradlew assembleDebug).
실행: python3 frontend/car/short_e2e.py frontend/car/app/build/outputs/apk/debug/app-debug.apk <저장소 밖 폴더>
- ANDROID_SERIAL을 주면 이 스크립트와 공유 캡처 도구의 adb 대상을 함께 바꾼다. 기본값은 e2e.py의 emulator-5554이다.
  Virtual Console은 기존 localhost:8088을 사용하므로 같은 기기로 adb forward tcp:8088 tcp:8088을 설정한다.

- 숏폼 구성(GET /api/trips/{code}/shortform)과 클립(GET …/recordings/{id})은 #63 계약 모양의 가짜 응답을 이 스크립트가 낸다
  (SHORT_PORT, 기본 8798). 나머지 요청은 그대로 서버로 넘긴다. 서버의 숏폼이 들어오면 FAKE=0으로 서버에 바로 붙는다.
  가짜 응답도 참가자 토큰(Bearer)이 없으면 401로 거절한다.
- 클립 소리는 macOS say(Yuna) 합성 음성이다.
순서: 여행 만들기 → P에서 동의 켬 → 쇼츠 탭·생성된 쇼츠 보기 → 장면 1(우리 수음은 멈춤) → 기어 D(재생 종료)
      → P → 다시 재생 → 마지막 장면 일시정지 → 닫기·함께 타는 중 → 수음 재개
      → Gleo로 멈춘 채 쇼츠 재생·재개 호출 → 닫은 뒤 수음 재개 → 재생 중 동의 철회·클립 삭제
      → 클립을 받는 중에 동의 철회(가짜 프록시가 클립을 천천히 보냄) → 망을 끊고 멈춘 채 동의 철회 → OUT/results.json
"""
import http.server, json, os, re, subprocess, sys, tempfile, threading, time, urllib.request, wave
import numpy as np
import e2e, capture_e2e as cap, gleo_e2e as gl
from e2e import ADB, PKG, OUT, adb, shot, texts, tap_text, tap_switch, gear, check, note

# cap·gl도 같은 ADB 리스트를 import한다. 대입 대신 내용을 바꿔 모든 helper의 대상을 맞춘다.
if os.environ.get("ANDROID_SERIAL"):
    e2e.ADB[:] = [e2e.ADB[0], "-s", os.environ["ANDROID_SERIAL"]]

UP = f"http://localhost:{cap.PORT}"
FAKE = os.environ.get("FAKE", "1") == "1"
SHORT_PORT = int(os.environ.get("SHORT_PORT", "8798"))
SCENES = [  # 장면마다 (말한 사람 이름 또는 None, 자리, 대사)
    ("바다 이야기", [("하은", "ROW_2_RIGHT", "아빠, 바다는 왜 짜?"), (None, "ROW_1_LEFT", "바닷물에 소금이 녹아 있어서 그래")]),
    ("수수께끼", [("서준", "ROW_2_LEFT", "세상에서 가장 뜨거운 과일은?"), ("엄마", "ROW_1_RIGHT", "천도복숭아!")]),
]
served = []


def clip(lines):
    """대사를 1초 쉼으로 이은 16 kHz 모노 WAV와 자막 큐(초)."""
    xs, cues, t = [], [], 0.5
    for _, _, text in lines:
        x = cap.say(text, "엄마"); xs.append(np.zeros(int(cap.R * (0.5 if not cues else 1.0)), "<i2")); xs.append(x)
        cues.append((t, t + len(x) / cap.R, text)); t += len(x) / cap.R + 1.0
    xs.append(np.zeros(cap.R, "<i2"))
    pcm = np.concatenate(xs)
    f = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    with wave.open(f.name, "wb") as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(cap.R); w.writeframes(pcm.tobytes())
    return open(f.name, "rb").read(), cues, len(pcm) / cap.R


class Proxy(http.server.BaseHTTPRequestHandler):
    clips = {}
    down = False  # 참이면 답하지 않고 연결을 닫는다(차 쪽에서 보면 망이 끊김)
    slow = False  # 참이면 클립을 30초 동안 조금씩 보낸다(받는 중에 그만두는지 보려고)
    cut = None  # 느린 클립을 보내다 차가 연결을 끊은 때(time.time())

    def log_message(self, *a): pass

    def send(self, code, body, ctype="application/json"):
        self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def fake(self):
        m = re.match(r"^/api/trips/(\w+)/(shortform|recordings/(\w+))$", self.path)
        if not (FAKE and self.command == "GET" and m): return False
        auth = self.headers.get("Authorization", "")
        served.append({"path": self.path, "bearer": auth.startswith("Bearer ") and len(auth) > 20})
        if not auth.startswith("Bearer "): self.send(401, b'{"error":"token","type":"unauthorized"}'); return True
        code = m.group(1)
        if m.group(2) == "shortform":
            trip = json.load(urllib.request.urlopen(f"{UP}/api/trips/{code}", timeout=5))
            by_name = {p["name"]: p for p in trip["participants"]}
            scenes = []
            for i, (label, lines) in enumerate(SCENES):
                wav, cues, secs = self.clips[i]  # main에서 합성 완료. setdefault의 기본값도 매 요청마다 실행되므로 쓰지 않는다.
                scenes.append({"momentId": f"m{i + 1}", "label": label, "at": 0, "clip": f"/api/trips/{code}/recordings/m{i + 1}", "startAt": 0, "seconds": round(secs, 2),
                               "cues": [{"start": round(a, 2), "end": round(b, 2), "text": text, "participantId": by_name[who]["id"] if who in by_name else None, "seatArea": seat}
                                        for (a, b, text), (who, seat, _) in zip(cues, lines)]})
            body = {"generation": trip.get("generation", 1), "title": trip.get("title", ""), "cast": [{"participantId": p["id"], "name": p["name"], "character": "", "seat": p["seat"]} for p in trip["participants"]], "scenes": scenes}
            self.send(200, json.dumps(body, ensure_ascii=False).encode())
        else:
            i = int(m.group(3)[1:]) - 1
            body = self.clips[i][0]
            if not Proxy.slow: self.send(200, body, "audio/wav"); return True
            self.send_response(200); self.send_header("Content-Type", "audio/wav"); self.send_header("Content-Length", str(len(body))); self.end_headers()
            try:
                self.wfile.write(body[:16384]); self.wfile.flush()
                for k in range(60): time.sleep(0.5); self.wfile.write(body[16384 + k:16385 + k]); self.wfile.flush()
                self.wfile.write(body[16444:])
            except OSError: Proxy.cut = time.time()
        return True

    def forward(self):
        if Proxy.down: return
        if self.fake(): return
        n = int(self.headers.get("Content-Length") or 0); data = self.rfile.read(n) if n else None
        req = urllib.request.Request(UP + self.path, data=data, method=self.command, headers={k: v for k, v in self.headers.items() if k.lower() in ("content-type", "authorization", "if-none-match")})
        try: r = urllib.request.urlopen(req, timeout=10); code, body, ctype = r.status, r.read(), r.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e: code, body, ctype = e.code, e.read(), e.headers.get("Content-Type", "application/json")
        if code == 304: self.send_response(304); self.end_headers(); return
        self.send(code, body, ctype)

    do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = forward


def stage_visible(ui):
    return any(re.fullmatch(r"\d+ / \d+ 장면", text) for text in ui)


def scene_visible(ui, index, label):
    # GeneratedShortStage의 장면 번호와 이름은 서로 다른 Text 노드다.
    return f"{index} / 2 장면" in ui and label in ui


def open_short():
    tap_text("쇼츠")
    cap.wait_texts(lambda u: "생성된 쇼츠 보기" in u, 10)
    return tap_text("생성된 쇼츠 보기")


def close_short_to_ride():
    tap_text("닫기")
    cap.wait_texts(lambda u: "생성된 쇼츠 보기" in u and not stage_visible(u), 10)
    tap_text("함께 타는 중")


def main(apk):
    for i, (_, lines) in enumerate(SCENES): Proxy.clips[i] = clip(lines)  # 미리 만든다. 요청 때 합성하면 차의 읽기 제한(5초)을 넘었다(11/14 4회차)
    srv = http.server.ThreadingHTTPServer(("0.0.0.0", SHORT_PORT), Proxy); threading.Thread(target=srv.serve_forever, daemon=True).start()
    threading.Thread(target=e2e.heartbeat, daemon=True).start()
    note("apk", sha256=e2e.hashlib.sha256(open(apk, "rb").read()).hexdigest(), fake=FAKE, serial=ADB[-1])
    note("install", out=subprocess.run(ADB + ["install", "--user", "10", "-r", "-g", apk], capture_output=True, text=True).stdout.strip()[-120:])
    gear("Park")
    adb("shell", "am", "force-stop", "--user", "10", PKG); adb("shell", "pm", "clear", "--user", "10", PKG)
    for perm in ("RECORD_AUDIO", "POST_NOTIFICATIONS"): adb("shell", "pm", "grant", "--user", "10", PKG, f"android.permission.{perm}")
    adb("shell", "am", "start", "--user", "10", "-n", f"{PKG}/.MainActivity", "--es", "server", f"http://10.0.2.2:{SHORT_PORT if FAKE else cap.PORT}")
    time.sleep(4); e2e.tap_make(); time.sleep(4)
    tap_switch()
    ui = cap.wait_texts(lambda u: "● 기록 중" in u, 10)
    check("P에서 동의를 켜면 기록 중", "● 기록 중" in ui)

    open_short()
    ui = cap.wait_texts(lambda u: scene_visible(u, 1, "바다 이야기"), 15); shot("1-playing"); note("ui", texts=ui)
    check("쇼츠 장면 1을 그 자리에서 재생: 진행·장면 이름", scene_visible(ui, 1, "바다 이야기"))
    first_cues = [("하은", "아빠, 바다는 왜 짜?"), ("운전석", "바닷물에 소금이 녹아 있어서 그래")]
    ui = cap.wait_texts(lambda u: scene_visible(u, 1, "바다 이야기") and any(who in u and text in u for who, text in first_cues), 10); note("ui", texts=ui)
    card = next(([who, text] for who, text in first_cues if who in ui and text in ui), [])
    check("자막과 말한 사람(이름, 못 붙인 사람은 자리)", scene_visible(ui, 1, "바다 이야기") and bool(card), card=card)
    if FAKE: check("참가자 토큰(Bearer)으로 구성과 클립을 받음", any(s["path"].endswith("/shortform") for s in served) and any("/recordings/" in s["path"] for s in served) and all(s["bearer"] for s in served), served=served)
    check("쇼츠가 열린 동안 우리 수음은 멈춤(재생 소리가 기록에 들어가지 않게)", stage_visible(ui) and not gl.ours_recording())
    gear("Drive"); time.sleep(3); ui = texts(); shot("2-drive-hidden"); note("ui", texts=ui)
    check("주행 중에는 쇼츠를 닫고 열기 단추를 가림(수음은 다시)", not stage_visible(ui) and "생성된 쇼츠 보기" not in ui and gl.ours_recording())
    gear("Park"); time.sleep(3)
    open_short()
    ui = cap.wait_texts(lambda u: scene_visible(u, 2, "수수께끼"), 40); shot("3-scene2"); note("ui", texts=ui)
    check("장면이 끝나면 다음 장면으로", scene_visible(ui, 2, "수수께끼"))
    ui = cap.wait_texts(lambda u: scene_visible(u, 2, "수수께끼") and "재생" in u, 40); shot("4-paused-at-end"); note("ui", texts=ui)
    check("마지막 장면이 끝나면 일시정지하고 수음은 계속 멈춤", scene_visible(ui, 2, "수수께끼") and "재생" in ui and not gl.ours_recording())
    close_short_to_ride()
    ui = cap.wait_texts(lambda u: "● 기록 중" in u, 10); shot("4-done"); note("ui", texts=ui)
    check("쇼츠를 닫으면 다시 기록 중(마이크도)", not stage_visible(ui) and "● 기록 중" in ui and gl.ours_recording())

    # 다시 기록 단추는 live 탭에 있다. 같은 재개 경로를 쓰는 Gleo 인텐트로 쇼츠를 유지한 채 검사한다.
    gl.gleo_call("GACHITA_PAUSE_RECORDING"); time.sleep(3)
    open_short(); cap.wait_texts(lambda u: scene_visible(u, 1, "바다 이야기"), 15)
    gl.gleo_call("GACHITA_RESUME_RECORDING"); time.sleep(3); ui = texts(); note("ui", texts=ui)
    check("Gleo로 멈춘 채 듣는 중 재개 호출: 쇼츠를 유지하고 수음은 열지 않음", stage_visible(ui) and not gl.ours_recording())
    close_short_to_ride()
    ui = cap.wait_texts(lambda u: "● 기록 중" in u, 10); note("ui", texts=ui)
    check("쇼츠를 닫으면 그때 다시 기록", not stage_visible(ui) and "● 기록 중" in ui and gl.ours_recording())

    # 동의 철회 뒤에는 쇼츠 라이브러리에 머문다. 무대가 닫힌 것과 live의 기록 상태를 따로 검사한다.
    open_short(); ui = cap.wait_texts(lambda u: scene_visible(u, 1, "바다 이야기"), 15)
    cached = [f for f in adb("exec-out", "run-as", PKG, "--user", "10", "ls", "cache").split() if f.startswith("short")]
    tap_switch(); time.sleep(3); ui = texts(); shot("5-consent-off"); note("ui", texts=ui)
    left = [f for f in adb("exec-out", "run-as", PKG, "--user", "10", "ls", "cache").split() if f.startswith("short")]
    check("듣는 동안 동의를 끄면 쇼츠를 닫고 받은 클립이 남지 않음", cached and not left and not stage_visible(ui) and "생성된 쇼츠 보기" in ui, cached=cached, left=left)
    tap_text("함께 타는 중")
    ui = cap.wait_texts(lambda u: "기록 꺼짐" in u, 10); shot("5b-recording-off"); note("ui", texts=ui)
    check("동의 철회 뒤 기록 꺼짐이고 실제 수음도 멈춤", not stage_visible(ui) and "기록 꺼짐" in ui and not gl.ours_recording())

    # 클립을 받는 중에 동의를 끄면 다 받기를 기다리지 않고 연결을 끊고 받던 파일을 지운다. 동의 끄기 요청은 받기 뒤에 서지 않는다(Astra #238 재리뷰)
    tap_switch(); cap.wait_texts(lambda u: "● 기록 중" in u, 15)
    Proxy.slow = True; Proxy.cut = None
    open_short(); time.sleep(4)  # 구성은 바로, 클립은 30초에 걸쳐 온다
    part = [f for f in adb("exec-out", "run-as", PKG, "--user", "10", "ls", "cache").split() if f.startswith("short")]
    t0 = time.time(); tap_switch(); time.sleep(4); ui = texts(); shot("6-off-while-downloading"); note("ui", texts=ui)
    left = [f for f in adb("exec-out", "run-as", PKG, "--user", "10", "ls", "cache").split() if f.startswith("short")]
    code = re.search(r"/api/trips/(\w+)/", served[0]["path"]).group(1)
    off = not any(p["consent"] for p in json.load(urllib.request.urlopen(f"{UP}/api/trips/{code}", timeout=5))["participants"])
    cut = round(Proxy.cut - t0, 1) if Proxy.cut else None  # 화면 읽기·탭 지연 포함(1회차 3.6초). 고치기 전에는 30초를 다 받아 끊기지 않았다
    check("클립을 받는 중에 동의를 끄면 연결을 끊고 받던 파일을 지우며, 서버의 동의 끄기는 받기를 기다리지 않음",
          bool(part) and not left and cut is not None and cut < 10 and off, part=part, left=left, cut_s=cut, server_off=off)
    Proxy.slow = False
    tap_text("함께 타는 중"); cap.wait_texts(lambda u: "기록 꺼짐" in u, 10)

    # 망이 끊긴 채 차에서 동의를 꺼도 서버 답을 기다리지 않고 숏폼을 닫고 클립을 지운다. 철회가 서버에 닿기 전에는 새 숏폼도 받지 않는다
    tap_switch(); cap.wait_texts(lambda u: "● 기록 중" in u, 15)
    open_short(); ui = cap.wait_texts(lambda u: scene_visible(u, 1, "바다 이야기"), 15)
    tap_text("일시정지"); time.sleep(1)  # 멈춘 채 끄면 클립이 캐시에 남던 경우(Astra #238)
    cached = [f for f in adb("exec-out", "run-as", PKG, "--user", "10", "ls", "cache").split() if f.startswith("short")]
    Proxy.down = True; note("net", down=True)
    tap_switch(); time.sleep(3); ui = texts(); shot("6-offline-off"); note("ui", texts=ui)
    left = [f for f in adb("exec-out", "run-as", PKG, "--user", "10", "ls", "cache").split() if f.startswith("short")]
    check("망이 끊긴 채 동의를 꺼도 쇼츠를 바로 닫고 받은 클립이 남지 않음", cached and not left and not stage_visible(ui), cached=cached, left=left)
    n = len(served); tap_text("생성된 쇼츠 보기"); time.sleep(3); ui = texts(); note("ui", texts=ui)
    check("철회가 서버에 닿기 전에는 쇼츠를 다시 받지 않음", len(served) == n and not stage_visible(ui), served=served[n:])
    Proxy.down = False; note("net", down=False)

    (OUT / "results.json").write_text(json.dumps(e2e.log, ensure_ascii=False, indent=1))
    fails = [x for x in e2e.log if x["step"] == "check" and not x["ok"]]
    print(f"검사 {sum(1 for x in e2e.log if x['step'] == 'check')}개 중 실패 {len(fails)}")
    srv.shutdown(); sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main(sys.argv[1])
