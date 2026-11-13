"""원음과 장면 클립 E2E(T63): 차가 수음하며 원음을 암호화해 쌓고, 사람이 확정한 장면의 구간을 16 kHz 모노 WAV로 잘라 API(POST /recordings)로 올리는지 본다.

준비: capture_e2e.py와 같다(Cold boot한 Pleos 에뮬레이터 -grpc 8556 -grpc-use-token -audio none, adb forward tcp:8088 tcp:8088, ./gradlew assembleDebug).
      서버는 클립 API(T76)가 있는 것을 가짜 S3에 붙여 띄운다. 이 스크립트가 가짜 S3를 127.0.0.1:GACHITA_S3_PORT(기본 9787)에 연다:
        CLIPS_BUCKET=clips AWS_ENDPOINT_URL_S3=http://127.0.0.1:9787 AWS_REGION=ap-northeast-2 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \\
        PORT=8797 DATABASE_URL=... node backend/api/server.js
실행: GACHITA_PORT=8797 python3 frontend/car/clip_e2e.py <APK> <저장소 밖 폴더> [시간(분)]
      시간을 주면 그만큼 가족 대화를 더 넣으며 원음을 쌓고 30초마다 CPU·메모리·원음 파일 크기를 잰다(1시간 자원 측정).

순서: 여행 → 폰 참가자 → 모두 동의(수음 시작) → 가족 대화 다섯 문장을 넣음 → 받아 적은 발화 시각으로 장면 둘을 남김(POST /moments)
      → 차가 장면 구간을 잘라 올림 → GET /recordings로 받아 형식(16 kHz 모노 16비트)·길이·내용(넣은 소리와 포락선 상관)을 봄
      → 원음 파일이 암호화돼 있는지(받은 클립의 표본이 파일에 없음) → [분]만큼 더 넣으며 자원 측정
      → '이 차에 둔 원음 지우기'(기록 중: 지난 원음이 지워지고 새 파일로 이어 씀) → 동의 끄기(원음 파일이 모두 지워짐).
- 넣는 소리는 macOS say(Yuna) 합성 음성이다. 사람 목소리가 아니다. 결과는 OUT/results.json, 클립은 OUT/clips/에 둔다(저장소에 넣지 않음).
"""
import http.server, io, json, os, pathlib, sys, threading, time, urllib.request, wave
import numpy as np
import e2e, capture_e2e as cap
from e2e import ADB, PKG, OUT, adb, shot, texts, tap_text, tap_switch, gear, check, note, phone_join, phone_consent
from capture_e2e import PORT, R, TALK, Injector, fixture, wait_texts, wait_uploaded, mic_holders, sampler, usage, samples, sampling

S3_PORT = int(os.environ.get("GACHITA_S3_PORT", "9787"))
API = f"http://localhost:{PORT}"
s3 = {}  # 가짜 클립 버킷: 키 → 바이트


class S3(http.server.BaseHTTPRequestHandler):
    """경로 방식 S3(PUT·GET·DELETE /clips/<키>)만. 서버의 AWS SDK가 IP 주소 엔드포인트라 경로 방식으로 부른다."""
    def _key(self): return self.path.split("?")[0].removeprefix("/clips/")
    def do_PUT(self):
        n = int(self.headers.get("content-length", 0)); s3[self._key()] = self.rfile.read(n)
        self.send_response(200); self.send_header("ETag", '"x"'); self.end_headers()
    def do_GET(self):
        b = s3.get(self._key())
        if b is None: self.send_response(404); self.send_header("content-type", "application/xml"); self.end_headers(); self.wfile.write(b"<Error><Code>NoSuchKey</Code></Error>"); return
        self.send_response(200); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_DELETE(self): s3.pop(self._key(), None); self.send_response(204); self.end_headers()
    def log_message(self, *a): pass


def api(method, path, token, body=None):
    req = urllib.request.Request(API + path, data=json.dumps(body).encode() if body is not None else None, method=method,
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=10) as r: return r.status, r.read()


def raw_files():
    return sorted(f for f in adb("exec-out", "run-as", PKG, "--user", "10", "ls", "-l", "files").splitlines() if " audio-" in f)


def raw_bytes(name):
    return subprocess_bytes(["exec-out", "run-as", PKG, "--user", "10", "cat", f"files/{name}"])


def subprocess_bytes(a):
    import subprocess
    return subprocess.run(ADB + a, capture_output=True).stdout


def env10(x):
    """10 ms 포락선(dB). 소리 위치 맞추기에 쓴다(에뮬레이터가 소리를 다시 샘플링해 표본 단위로는 같지 않음, 11/13)."""
    x = x.astype(np.float64); n = len(x) // 160
    return 20 * np.log10(np.sqrt((x[:n * 160].reshape(n, 160) ** 2).mean(1)) + 1)


def match(clip, ref):
    """클립 포락선이 넣은 소리(ref) 어디에 가장 잘 맞는지: (상관, 위치 초)."""
    a = env10(clip); b = env10(ref); a = (a - a.mean()) / (a.std() + 1e-9)
    best = (-1, 0)
    for i in range(0, len(b) - len(a) + 1):
        w = b[i:i + len(a)]; c = float((a * (w - w.mean()) / (w.std() + 1e-9)).mean())
        if c > best[0]: best = (c, i / 100)
    return round(best[0], 3), round(best[1], 2)


def main(apk, minutes):
    threading.Thread(target=e2e.heartbeat, daemon=True).start()
    threading.Thread(target=cap.logcat, daemon=True).start()
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", S3_PORT), S3); threading.Thread(target=srv.serve_forever, daemon=True).start()
    inj = Injector()
    five = fixture("five", TALK[:5], tail=4.0)
    if minutes: fixture("long", TALK * 20, seconds=minutes * 60)
    note("apk", sha256=e2e.hashlib.sha256(open(apk, "rb").read()).hexdigest())
    note("install", out=e2e.subprocess.run(ADB + ["install", "--user", "10", "-r", "-g", apk], capture_output=True, text=True).stdout.strip()[-200:])
    gear("Park")
    adb("shell", "am", "force-stop", "--user", "10", PKG); adb("shell", "pm", "clear", "--user", "10", PKG)
    for perm in ("RECORD_AUDIO", "POST_NOTIFICATIONS"): adb("shell", "pm", "grant", "--user", "10", PKG, f"android.permission.{perm}")
    adb("shell", "am", "start", "--user", "10", "-n", f"{PKG}/.MainActivity", "--es", "server", f"http://10.0.2.2:{PORT}")
    time.sleep(4); tap_text("여행 만들기"); time.sleep(4)
    code = next((t.split()[-1] for t in texts() if t.startswith("여행 코드")), None); note("trip", code=code)
    phone = phone_join(code)
    wait_texts(lambda u: "일행 5명" in u, 15); tap_switch(); wait_texts(lambda u: "동의 대기" in " ".join(u), 10)
    phone_consent(code, phone, True)
    ui = wait_texts(lambda u: "● 기록 중" in u, 15)
    if not check("모두 동의하면 기록 중", "● 기록 중" in ui): raise SystemExit("수음이 열리지 않아 멈춥니다")
    # 1. 다섯 문장을 넣고 서버에 올라간 발화의 시각으로 장면 둘을 남긴다(폰에서 고른 것과 같은 요청)
    inj.play("five"); time.sleep(2)
    got = sorted(wait_uploaded(code, phone, 5, timeout=30)["items"], key=lambda u: u["seq"])
    note("heard", items=[(u["seq"], u["text"]) for u in got])
    picks = [got[2], got[4]] if len(got) >= 5 else got[-2:]
    moments = []
    for i, u in enumerate(picks):
        st, b = api("POST", f"/api/trips/{code}/moments", phone[1], {"at": u["at"], "label": f"장면 {i + 1}"})
        moments.append(json.loads(b)); note("moment", status=st, id=moments[-1]["id"], at=u["at"], text=u["text"])
    # 2. 차가 구간(시각 앞 20초 ~ 뒤 10초)이 끝난 뒤 다음 조회에서 잘라 올린다
    deadline = time.time() + 60
    while time.time() < deadline and len(s3) < len(moments): time.sleep(2)
    note("s3", keys=sorted(s3))
    check("확정한 장면마다 클립 하나가 API를 거쳐 클립 버킷에 있음", len(s3) == len(moments) and all(any(m["id"] in k for k in s3) for m in moments), keys=sorted(s3))
    ref = np.frombuffer(wave.open(str(OUT / "inputs" / "five.wav")).readframes(10 ** 9), dtype="<i2").reshape(-1, 2).astype(np.int32).sum(1)
    (OUT / "clips").mkdir(exist_ok=True); clips = []
    for m in moments:
        st, b = api("GET", f"/api/trips/{code}/recordings/{m['id']}", phone[1])
        (OUT / "clips" / f"{m['id']}.wav").write_bytes(b)
        w = wave.open(io.BytesIO(b)); pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
        corr, at_s = match(pcm, ref)
        clips.append({"id": m["id"], "status": st, "rate": w.getframerate(), "channels": w.getnchannels(), "bits": w.getsampwidth() * 8,
                      "seconds": round(w.getnframes() / w.getframerate(), 2), "peak_dbfs": round(20 * np.log10(np.abs(pcm).max() / 32768 + 1e-9), 1), "corr": corr, "at_in_input_s": at_s})
    note("clips", clips=clips)
    check("받은 클립은 16 kHz 모노 16비트 WAV이고 말소리가 들어 있음", clips and all(c["rate"] == 16000 and c["channels"] == 1 and c["bits"] == 16 and c["peak_dbfs"] > -30 for c in clips), clips=clips)
    check("클립 소리가 넣은 대화와 맞음(10 ms 포락선 상관 0.6 이상)", clips and all(c["corr"] >= 0.6 for c in clips), corr=[c["corr"] for c in clips])
    files = raw_files(); note("raw", files=files)
    name = files[0].split()[-1] if files else None
    blob = raw_bytes(name) if name else b""
    first = np.frombuffer(wave.open(str(OUT / "clips" / f"{moments[0]['id']}.wav")).readframes(10 ** 9), dtype="<i2")
    probe = first[len(first) // 2:len(first) // 2 + 32].tobytes()  # 클립 가운데 표본 32개(말소리)
    check("차 안 원음 파일은 암호화돼 있음(받은 클립의 표본이 파일에 없음, WAV 머리 없음)", blob and probe not in blob and b"RIFF" not in blob[:64], file=name, bytes=len(blob))
    # 3. 자원: 원음을 쌓으며 [분] 동안 더 넣는다(내비를 앞에 둔 기어 D)
    if minutes:
        adb("shell", "am", "start", "--user", "10", "-n", cap.NAVI); time.sleep(3); gear("Drive")
        sampling.set(); res = {}
        th = threading.Thread(target=lambda: res.update(zip(("hz", "ncpu"), sampler())), daemon=True); th.start()
        log0 = len(cap.capture_log); sizes = []
        ticker = threading.Event()
        def size_loop():  # 30초마다 원음 파일 크기와 /data 남은 공간
            while not ticker.is_set():
                df = adb("shell", "df", "-k", "/data").split()
                sizes.append({"t": round(time.time()), "raw_bytes": sum(int(l.split()[4]) for l in raw_files()), "data_free_kb": int(df[-3]) if len(df) > 3 else None})
                ticker.wait(30)
        threading.Thread(target=size_loop, daemon=True).start()
        inj.play("long"); time.sleep(5)
        sampling.clear(); ticker.set(); th.join(60)
        use = usage(res.get("hz", 100), res.get("ncpu", 4))
        (OUT / "resources.json").write_text(json.dumps({"samples": samples, "usage": use, "sizes": sizes}, ensure_ascii=False, indent=1))
        note("usage", rows=use, raw_start=sizes[0] if sizes else None, raw_end=sizes[-1] if sizes else None)
        window = cap.capture_log[log0:]
        check(f"{minutes}분 동안 원음을 쌓으며 막힘 없음", not any("BLOCKED" in c["line"] or "녹음 끝" in c["line"] or "원음을 쓰지 못함" in c["line"] for c in window))
        gear("Park"); adb("shell", "am", "start", "--user", "10", "-n", f"{PKG}/.MainActivity"); time.sleep(3)
    # 4. 원음 지우기(기록 중): 지난 원음이 지워지고 그 뒤로는 새 파일에 이어 쓴다. 받아 적은 글과 동의는 그대로
    before = raw_files()
    tap_text("이 차에 둔 원음 지우기"); time.sleep(3)
    after = raw_files(); ui = texts(); note("raw.drop", before=before, after=after, ui=ui)
    check("원음 지우기: 지난 원음 파일이 지워지고 새 파일로 이어 씀(기록은 계속)", before and after and not set(before) & set(after) and "● 기록 중" in ui,
          before=[l.split()[-1] for l in before], after=[l.split()[-1] for l in after])
    # 5. 동의를 끄면 원음 파일이 모두 지워진다(동의 세대가 오름)
    tap_switch(); time.sleep(5)
    left = raw_files(); note("raw.off", files=left)
    check("동의를 끄면 원음 파일이 모두 지워짐", not left and not mic_holders(), files=left)
    gear("Park")
    (OUT / "results.json").write_text(json.dumps({"code": code, "clips": clips, "log": e2e.log}, ensure_ascii=False, indent=1))
    fails = [e["name"] for e in e2e.log if e["step"] == "check" and not e["ok"]]
    print("실패:", fails if fails else "없음")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main(sys.argv[1], float(sys.argv[3]) if len(sys.argv) > 3 else 0)
