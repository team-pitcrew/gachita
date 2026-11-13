"""숏폼 그 자리 재생 E2E(T43 차 몫): 주차 중 '숏폼 보기'로 장면 클립을 차례로 틀고 자막과 말한 사람을 보이며, 주행 중에는 가린다.

준비: capture_e2e.py와 같다(make run 또는 GACHITA_PORT의 서버, -grpc 8556 -grpc-use-token -audio none으로 켠 에뮬레이터,
      adb forward tcp:8088 tcp:8088, ./gradlew assembleDebug).
실행: python3 frontend/car/short_e2e.py frontend/car/app/build/outputs/apk/debug/app-debug.apk <저장소 밖 폴더>

- 숏폼 구성(GET /api/trips/{code}/shortform)과 클립(GET …/recordings/{id})은 #63 계약 모양의 가짜 응답을 이 스크립트가 낸다
  (SHORT_PORT, 기본 8798). 나머지 요청은 그대로 서버로 넘긴다. 서버의 숏폼이 들어오면 FAKE=0으로 서버에 바로 붙는다.
  가짜 응답도 참가자 토큰(Bearer)이 없으면 401로 거절한다.
- 클립 소리는 macOS say(Yuna) 합성 음성이다.
순서: 여행 만들기 → P에서 동의 켬 → '숏폼 보기' → 장면 1 재생(자막·말한 사람, 우리 수음은 멈춤) → 기어 D(재생 멈춤·카드 가림)
      → P → 다시 '숏폼 보기' → 끝까지(장면 2) → 수음 다시 → 결과 OUT/results.json
"""
import http.server, json, os, re, subprocess, sys, tempfile, threading, time, urllib.request, wave
import numpy as np
import e2e, capture_e2e as cap
from e2e import ADB, PKG, OUT, adb, shot, texts, tap_text, tap_switch, gear, check, note

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
                wav, cues, secs = self.clips.setdefault(i, clip(lines))
                scenes.append({"momentId": f"m{i + 1}", "label": label, "at": 0, "clip": f"/api/trips/{code}/recordings/m{i + 1}", "startAt": 0, "seconds": round(secs, 2),
                               "cues": [{"start": round(a, 2), "end": round(b, 2), "text": text, "participantId": by_name[who]["id"] if who in by_name else None, "seatArea": seat}
                                        for (a, b, text), (who, seat, _) in zip(cues, lines)]})
            body = {"title": trip.get("title", ""), "cast": [{"participantId": p["id"], "name": p["name"], "character": "", "seat": p["seat"]} for p in trip["participants"]], "scenes": scenes}
            self.send(200, json.dumps(body, ensure_ascii=False).encode())
        else:
            i = int(m.group(3)[1:]) - 1
            self.send(200, self.clips.setdefault(i, clip(SCENES[i][1]))[0], "audio/wav")
        return True

    def forward(self):
        if self.fake(): return
        n = int(self.headers.get("Content-Length") or 0); data = self.rfile.read(n) if n else None
        req = urllib.request.Request(UP + self.path, data=data, method=self.command, headers={k: v for k, v in self.headers.items() if k.lower() in ("content-type", "authorization", "if-none-match")})
        try: r = urllib.request.urlopen(req, timeout=10); code, body, ctype = r.status, r.read(), r.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e: code, body, ctype = e.code, e.read(), e.headers.get("Content-Type", "application/json")
        if code == 304: self.send_response(304); self.end_headers(); return
        self.send(code, body, ctype)

    do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = forward


def ours_playing():
    """우리 앱이 소리를 내는 중인지(dumpsys audio의 재생 목록)."""
    out = adb("shell", "dumpsys", "audio")
    sec = out.split("playback activity", 1)[-1].split("\n\n", 1)[0] if "playback activity" in out else out
    return any("state:started" in l and "usage=USAGE_MEDIA" in l for l in sec.splitlines() if str(uid()) in l)


def uid():
    m = re.search(r"userId=(\d+)", adb("shell", "dumpsys", "package", PKG)); return int(m.group(1)) + 1_000_000 if m else -1


def main(apk):
    srv = http.server.ThreadingHTTPServer(("0.0.0.0", SHORT_PORT), Proxy); threading.Thread(target=srv.serve_forever, daemon=True).start()
    threading.Thread(target=e2e.heartbeat, daemon=True).start()
    note("apk", sha256=e2e.hashlib.sha256(open(apk, "rb").read()).hexdigest(), fake=FAKE)
    note("install", out=subprocess.run(ADB + ["install", "--user", "10", "-r", "-g", apk], capture_output=True, text=True).stdout.strip()[-120:])
    gear("Park")
    adb("shell", "am", "force-stop", "--user", "10", PKG); adb("shell", "pm", "clear", "--user", "10", PKG)
    for perm in ("RECORD_AUDIO", "POST_NOTIFICATIONS"): adb("shell", "pm", "grant", "--user", "10", PKG, f"android.permission.{perm}")
    adb("shell", "am", "start", "--user", "10", "-n", f"{PKG}/.MainActivity", "--es", "server", f"http://10.0.2.2:{SHORT_PORT if FAKE else cap.PORT}")
    time.sleep(4); tap_text("여행 만들기"); time.sleep(4)
    tap_switch()
    ui = cap.wait_texts(lambda u: "● 기록 중" in u, 10)
    check("P에서 동의를 켜면 기록 중", "● 기록 중" in ui)

    tap_text("숏폼 보기")
    ui = cap.wait_texts(lambda u: any(t.startswith("1 / 2") for t in u), 15); shot("1-playing"); note("ui", texts=ui)
    check("숏폼 장면 1을 그 자리에서 재생: 진행·장면 이름", any(t.startswith("1 / 2") and "바다 이야기" in t for t in ui))
    check("참가자 토큰(Bearer)으로 구성과 클립을 받음", served and all(s["bearer"] for s in served), served=served)
    time.sleep(1.5); ui = texts(); note("ui", texts=ui)
    check("자막과 말한 사람(이름, 못 붙인 사람은 자리)", "아빠, 바다는 왜 짜?" in ui and "하은" in ui or "바닷물에 소금이 녹아 있어서 그래" in ui and "운전석" in ui, texts=ui)
    check("재생하는 동안 우리 수음은 멈춤(재생 소리가 기록에 들어가지 않게)", not cap.mic_holders() or not any("silenced:false" in l for l in cap.mic_holders()))
    gear("Drive"); time.sleep(3); ui = texts(); shot("2-drive-hidden"); note("ui", texts=ui)
    check("주행 중에는 숏폼 카드를 가리고 재생을 멈춤", not any(t.startswith("1 / 2") or t == "숏폼 보기" for t in ui))
    gear("Park"); time.sleep(3)
    tap_text("숏폼 보기")
    ui = cap.wait_texts(lambda u: any(t.startswith("2 / 2") for t in u), 40); shot("3-scene2"); note("ui", texts=ui)
    check("장면이 끝나면 다음 장면으로", any(t.startswith("2 / 2") and "수수께끼" in t for t in ui))
    ui = cap.wait_texts(lambda u: "숏폼 보기" in u and "● 기록 중" in u, 40); shot("4-done"); note("ui", texts=ui)
    check("끝나면 카드가 닫히고 다시 기록 중", "● 기록 중" in ui)

    (OUT / "results.json").write_text(json.dumps(e2e.log, ensure_ascii=False, indent=1))
    fails = [x for x in e2e.log if x["step"] == "check" and not x["ok"]]
    print(f"검사 {sum(1 for x in e2e.log if x['step'] == 'check')}개 중 실패 {len(fails)}")
    srv.shutdown(); sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main(sys.argv[1])
