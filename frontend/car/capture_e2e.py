"""수음과 실시간 전사 E2E(T36): 가상 마이크에 가족 대화를 넣고, 내비를 앞에 둔 기어 D에서 차량 앱이 받아 적어 보관함에 쌓는지 본다.

준비: e2e.py와 같다(make run, Cold boot한 Pleos 에뮬레이터, adb forward tcp:8088 tcp:8088, ./gradlew assembleDebug).
      에뮬레이터는 -grpc 8556 -grpc-use-token -audio none으로 켠다(소리 넣기, 호스트 마이크는 쓰지 않음).
실행: python3 frontend/car/capture_e2e.py frontend/car/app/build/outputs/apk/debug/app-debug.apk <저장소 밖 폴더> [분]
      분은 주행 구간 길이(기본 10). 넣는 소리는 macOS say(Yuna)로 만든 합성 음성이다. 사람 목소리가 아니다.

순서: 여행 만들기 → 폰 참가자 한 명이 API로 참가 → P에서 동의 켬(차 참가자만, 폰은 '동의 대기') → 폰이 자기 토큰으로 켬(수음 시작)
      → 내비를 앞에, 기어 D → 가족 대화를 [분] 동안 넣음(왼쪽 채널 = 앞줄, 오른쪽 = 뒷줄) → 30초마다 CPU·메모리
      → 서버에 올라간 발화(GET /utterances, 폰 참가자 토큰)를 보관함과 맞춰 봄 → P, 앱을 앞에
      → 내비가 앞일 때 시스템 마이크 차단으로 '기록 멈춤' → 풀기 → 동의 끔(마이크 놓음, 보관함의 글이 빔)
      → 앱 다시 켜기(보관함과 순번 이어짐, 새 동의 세대로 올라감)
      → 보관 기간을 줄여 다시 켜기(--el keepMs, 차 안 사본이 지워짐) → 새 여행을 서버에서 지움(404, 차 안 사본이 지워짐).
- 차 안 보관함은 암호화돼 있어(T69) 받아 적은 글은 서버 기록(GET /utterances, 폰 참가자 토큰)으로 맞춰 보고, 차 안 파일은 줄 수와 평문이 없는지만 본다.
- 서버에서 여행을 지우는 단계는 그 서버의 Postgres 컨테이너(GACHITA_PG, 기본 gachita-pg)에 psql로 지운다.
- 넣는 소리의 쉼에는 −77 dBFS 잡음을 깐다(막히지 않은 에뮬레이터 마이크의 무음 수준, T10). 디지털 0이면 막힘과 구별되지 않는다.
- GACHITA_PORT=8797처럼 주면 그 포트의 서버를 쓴다. 공용 DB(gachita-pg)는 다른 시험(make api)이 비울 수 있다.
- 소리는 우리 AudioRecord가 열려 있을 때만 넣는다(아무도 녹음하지 않을 때 넣으면 에뮬레이터가 멈춘 적이 있음, T10).
- 결과는 OUT/results.json, 넣은 문장과 받아 적은 문장은 OUT/transcript.tsv. 넣은 소리(WAV)는 OUT/inputs에 두고 저장소에 넣지 않는다.
"""
import importlib, json, os, pathlib, random, re, subprocess, sys, tempfile, threading, time, urllib.request, wave
import numpy as np
import e2e  # 같은 폴더의 T7 E2E: adb, 캡처, 화면 트리, 기어, 판정 기록을 같이 쓴다
from e2e import ADB, PKG, OUT, adb, shot, texts, tap_text, tap_switch, gear, check, note, phone_join, phone_consent

PORT = int(os.environ.get("GACHITA_PORT", "8787"))  # 공용 DB를 다른 시험이 비울 수 있어 따로 띄운 서버를 쓸 때(11/13 run2)
NOISE_DBFS = -77  # 막히지 않은 에뮬레이터 마이크의 무음 수준(T10). 넣는 소리의 쉼이 디지털 0이면 막힘과 구별되지 않는다


def server(code):
    t = json.load(urllib.request.urlopen(f"http://localhost:{PORT}/api/trips/{code}", timeout=5))
    note("server", code=code, recording=t["recording"], consent=[(p["name"], p["consent"]) for p in t["participants"]], version=t["version"])
    return t

R = 16000
NAVI = "ai.umos.maps.android.navigation.app/.MainActivity"
PROTO = pathlib.Path.home() / "Library/Android/sdk/emulator/lib/emulator_controller.proto"
ROW = {"아빠": 0, "엄마": 0, "아들": 1, "딸": 1}  # 0 = 왼쪽 채널(앞줄), 1 = 오른쪽(뒷줄)
PITCH = {"아빠": 0.84, "엄마": 1.0, "아들": 1.14, "딸": 1.28}  # Yuna 한 목소리를 음높이만 바꿈

# 티켓 완료 기준의 다섯 문장이 먼저, 그 뒤는 10분을 채우는 강릉 가는 길 대화(시험용으로 지은 것)
TALK = [
    ("딸", "바다는 왜 짜?"), ("아들", "그럼 미역국은 누가 끓여?"), ("엄마", "마트에서 우유랑 간식 사자"),
    ("아들", "화장실 가고 싶어"), ("아빠", "응, 다음 휴게소 가자"),
    ("엄마", "도윤아, 서아 안전벨트 한 번만 봐 줄래?"), ("아들", "서아 거 했어. 내가 채워 줬어."),
    ("딸", "아빠, 바다는 언제 보여?"), ("아빠", "산을 몇 개 넘어야 바다가 나와."),
    ("아들", "터널 들어가면 깜깜해지잖아. 나 숨 참을 거야."), ("엄마", "오늘은 둘이 싸우지 않기로 했지?"),
    ("아빠", "첫 번째 휴게소는 붐비니까 한 군데 지나서 들르자."), ("딸", "나는 젤리 먹을래."),
    ("엄마", "젤리는 한 봉지만이야. 이따 점심 먹어야 하니까."), ("아들", "숙소에 수영장 있어?"),
    ("아빠", "작은 실내 수영장이 있대. 저녁에도 할 수 있어."), ("딸", "내 분홍색 튜브도 챙겼어?"),
    ("엄마", "물안경이랑 튜브 다 넣었어."), ("아빠", "밥 먹고 바로 들어가면 배 아플 수 있어."),
    ("엄마", "강릉 날씨는 괜찮으려나? 바람 많이 불면 바다에 못 들어가는데."), ("아들", "심심해. 끝말잇기 하자."),
    ("딸", "나도 할래! 내가 먼저 할래."), ("엄마", "좋아. 기차로 시작하자."), ("아들", "차표."),
    ("딸", "표범!"), ("아빠", "범선."), ("아들", "선물!"), ("딸", "물고기!"),
    ("아빠", "그럼 수수께끼 낼게. 맞히는 사람은 휴게소에서 아이스크림."), ("아들", "좋아! 빨리 내 줘."),
    ("아빠", "세상에서 가장 뜨거운 과일은?"), ("아들", "천도복숭아!"), ("엄마", "정답이야. 천 도라서 뜨겁대."),
    ("딸", "하나 더 해 줘."), ("엄마", "숙소에서는 아이 가방부터 꺼내자."), ("딸", "도착하면 바다부터 보러 가자."),
    ("아빠", "저녁은 회 먹을까, 아니면 감자 옹심이 먹을까?"), ("아들", "나는 감자 옹심이."),
    ("엄마", "내일 아침에는 커피 거리에 가 보자."), ("딸", "나 졸려. 조금만 잘게."),
    ("아빠", "그래, 도착하면 깨워 줄게."), ("엄마", "휴대폰 충전기 챙겼지?"),
    ("아빠", "차에 하나 있어. 숙소 가서 하나 더 사자."), ("아들", "아빠, 이 노래 크게 틀어 줘."),
    ("엄마", "서아 자니까 조금만 작게 듣자."), ("아들", "알았어. 이어폰 낄게."),
    ("아빠", "다음 주에는 할머니 댁에도 들르자."), ("엄마", "할머니 드릴 감귤 한 상자 사 가자."),
    ("딸", "나 깼어. 바다 보여?"), ("아빠", "저기 오른쪽 봐. 바다 보인다."),
]
AFTER = ("아빠", "마이크가 다시 열렸으니 이 말은 적혀야 해")
AGAIN = ("딸", "앱을 다시 켜도 순번이 이어져야 해")


def say(text, who):
    """macOS say(Yuna) → 16 kHz 모노. 음높이는 표본을 빨리 읽어 바꾼다(시험용이라 선형 보간으로 충분)."""
    f = PITCH[who]
    with tempfile.TemporaryDirectory() as t:
        subprocess.run(["say", "-v", "Yuna", "-r", str(int(175 / f)), "-o", t + "/x.aiff", text], check=True)
        subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", t + "/x.aiff", t + "/x.wav"], check=True)
        with wave.open(t + "/x.wav") as w: x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float64)
    if f != 1.0: x = np.interp(np.arange(int(len(x) / f)) * f, np.arange(len(x)), x)
    idx = np.nonzero(np.abs(x) >= 200)[0]
    return np.clip(x[max(0, idx[0] - 160):idx[-1] + 160] if len(idx) else x, -32768, 32767).astype("<i2")


def fixture(name, lines, seconds=None, lead=1.0, tail=3.0, seed=36):
    """lines를 왼쪽(앞줄)·오른쪽(뒷줄) 채널에 나눠 놓은 스테레오 WAV. seconds가 있으면 쉼을 늘려 그 길이에 맞춘다."""
    voices = [(who, text, say(text, who)) for who, text in lines]
    speech = sum(len(x) for _, _, x in voices) / R
    rnd = random.Random(seed)
    gaps = [rnd.uniform(1.5, 3.0) for _ in voices]
    if seconds:  # 남는 시간을 쉼에 고르게 나눔. 0.8초 넘는 쉼은 STT가 매번 발화를 끊는다(11/13)
        k = (seconds - lead - tail - speech) / sum(gaps)
        gaps = [g * max(k, 1.0) for g in gaps]
    n = int(R * lead); rows = []; parts = []
    for (who, text, x), g in zip(voices, gaps):
        parts.append((n, x, ROW[who])); rows.append({"who": who, "text": text, "channel": "LR"[ROW[who]], "start_s": round(n / R, 3), "end_s": round((n + len(x)) / R, 3)})
        n += len(x) + int(R * g)
    n += int(R * tail)
    rms = 32768 * 10 ** (NOISE_DBFS / 20)  # 실제 마이크처럼 잡음 바닥을 깐다. 말소리(−14~−18 dBFS)보다 약 60 dB 작다
    st = np.random.default_rng(seed).normal(0, rms, (n, 2)).round()
    for at, x, ch in parts: st[at:at + len(x), ch] += x
    st = np.clip(st, -32768, 32767).astype("<i2")
    d = OUT / "inputs"; d.mkdir(exist_ok=True)
    with wave.open(str(d / f"{name}.wav"), "wb") as w: w.setnchannels(2); w.setsampwidth(2); w.setframerate(R); w.writeframes(st.tobytes())
    meta = {"name": name, "seconds": round(n / R, 2), "format": "16 kHz 2채널 s16le, 왼쪽 = 앞줄, 오른쪽 = 뒷줄", "voice": "macOS say Yuna(합성)",
            "noise_dbfs": NOISE_DBFS, "utterances": rows}
    (d / f"{name}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    note("fixture", name=name, seconds=meta["seconds"], lines=len(rows))
    return meta


class Injector:
    """에뮬레이터 gRPC injectAudio(토큰은 남기지 않음). 기본 모드는 누군가 녹음할 때만 소리를 당겨 가므로 실제 시간으로 흐른다."""
    def __init__(self):
        import grpc, grpc_tools
        from google.protobuf.empty_pb2 import Empty
        tmp = tempfile.mkdtemp(prefix="t36-proto-")
        subprocess.run([sys.executable, "-m", "grpc_tools.protoc", "-I" + str(PROTO.parent), "-I" + str(pathlib.Path(grpc_tools.__file__).parent / "_proto"),
                        "--python_out=" + tmp, "--grpc_python_out=" + tmp, str(PROTO)], check=True, capture_output=True)
        sys.path.insert(0, tmp); self.pb = importlib.import_module("emulator_controller_pb2"); svc = importlib.import_module("emulator_controller_pb2_grpc")
        grpc_port = os.environ.get("GACHITA_GRPC_PORT", "8556")
        found = []
        for ini in (pathlib.Path.home() / "Library/Caches/TemporaryItems/avd/running").glob("pid_*.ini"):
            kv = dict(l.split("=", 1) for l in ini.read_text().splitlines() if "=" in l)
            if kv.get("grpc.port") == grpc_port and kv.get("grpc.token"): found.append(kv["grpc.token"])
        if len(found) != 1: raise SystemExit(f"gRPC {grpc_port}과 토큰으로 켠 에뮬레이터가 하나여야 합니다(찾은 수 {len(found)})")
        self.md = [("authorization", "Bearer " + found[0])]
        self.stub = svc.EmulatorControllerStub(grpc.insecure_channel("127.0.0.1:" + grpc_port)); self.grpc = grpc
        if self.stub.getMicrophoneState(Empty(), metadata=self.md, timeout=5).realAudioEnabled:
            self.stub.setMicrophoneState(self.pb.MicrophoneState(realAudioEnabled=False), metadata=self.md, timeout=5)
        if self.stub.getMicrophoneState(Empty(), metadata=self.md, timeout=5).realAudioEnabled: raise SystemExit("호스트 마이크가 켜져 있어 멈춥니다")

    def play(self, name):
        """한 번 부르고 결과를 기다린다. 돌려주는 값은 넣기 시작 시각(Mac, ms)."""
        # 녹음 입력이 닫힌 채 넣으면 에뮬레이터가 죽는다(research/evidence/20261113-family-30min/에뮬레이터_충돌원인.md). 넣을 때마다 본다
        if not any("silenced:false" in l for l in mic_holders()):
            raise SystemExit(f"우리 녹음이 열려 있지 않아 '{name}'을 넣지 않고 멈춥니다")
        w = wave.open(str(OUT / "inputs" / f"{name}.wav"), "rb")
        fmt = self.pb.AudioFormat(samplingRate=R, channels=self.pb.AudioFormat.Stereo, format=self.pb.AudioFormat.AUD_FMT_S16, mode=self.pb.AudioFormat.MODE_UNSPECIFIED)
        def packets():
            while data := w.readframes(R // 10): yield self.pb.AudioPacket(format=fmt, timestamp=time.time_ns() // 1000, audio=data)
        t0 = int(time.time() * 1000); note("inject.start", name=name)
        try: self.stub.injectAudio(packets(), metadata=self.md, timeout=4000); res = "completed"
        except self.grpc.RpcError as e: res = e.code().name
        note("inject.done", name=name, result=res, wall_s=round(time.time() - t0 / 1000, 1))
        return t0


# ---- 앱 쪽에서 본 것 ------------------------------------------------------------------------------------------
capture_log = []


def logcat():
    """수음 상태 줄(GachitaCapture). 앱은 받아 적은 글자를 로그에 남기지 않는다."""
    adb("logcat", "-c")
    p = subprocess.Popen(ADB + ["logcat", "-v", "epoch", "GachitaCapture:I", "*:S"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    for line in p.stdout:
        m = re.match(r"\s*(\d+)\.(\d+)\s.*?GachitaCapture:\s(.*)", line)
        if m: capture_log.append({"device_ms": int(m.group(1)) * 1000 + int(m.group(2)), "line": m.group(3).strip()})


def vault(code):
    """차 안 파일 그대로(암호화돼 있어야 함): 보관함·상태 파일과 저장한 여행·토큰(환경설정). 읽지 못한 파일이 있으면 빈 값(헛통과 막기)."""
    import base64
    out = {f: adb("exec-out", "run-as", PKG, "--user", "10", "cat", f) for f in (f"files/utterances-{code}.jsonl", f"files/utterances-{code}.acked", f"files/todos-{code}.json", "shared_prefs/car.xml")}
    def sealed(line):  # Base64 봉투 한 줄: IV 12 + 태그 16바이트 이상
        try: return len(base64.b64decode(line.strip(), validate=True)) >= 28
        except Exception: return False
    ok = all(sealed(l) for l in out[f"files/utterances-{code}.jsonl"].splitlines() if l.strip()) and out[f"files/utterances-{code}.jsonl"].strip() \
        and sealed(out[f"files/utterances-{code}.acked"]) and "<map>" in out["shared_prefs/car.xml"] \
        and (sealed(out[f"files/todos-{code}.json"]) or "No such file" in out[f"files/todos-{code}.json"])  # 할 일은 '…에서 …자' 말이 있을 때만 생김
    note("vault", ok=bool(ok), sizes={k: len(v) for k, v in out.items()})
    return "".join(out.values()) if ok else ""


def lines(code):
    """보관함의 줄 수(발화 한 건 = 한 줄, 글을 지운 순번도 줄은 남음)."""
    return sum(1 for l in adb("exec-out", "run-as", PKG, "--user", "10", "cat", f"files/utterances-{code}.jsonl").splitlines() if l.strip())


def trip_files(code):
    return [f for f in adb("exec-out", "run-as", PKG, "--user", "10", "ls", "files").split() if code in f]


def uploaded(code, phone):
    """서버에 올라간 발화(GET /utterances). 동의한 참가자의 토큰으로만 읽힌다. 글을 비운 줄은 빠진다."""
    req = urllib.request.Request(f"http://localhost:{PORT}/api/trips/{code}/utterances", headers={"Authorization": f"Bearer {phone[1]}"})
    return json.load(urllib.request.urlopen(req, timeout=5))


def wait_uploaded(code, phone, n, timeout=25):
    """보관함의 발화 n건이 서버에 다 올라갈 때까지(10초 조회마다 올림)."""
    end = time.time() + timeout
    while True:
        got = uploaded(code, phone)
        if len(got["items"]) >= n or time.time() > end: return got
        time.sleep(2)


def mic_holders():
    """시스템이 보는 지금의 녹음(dumpsys audio의 녹음 목록) 가운데 우리 앱 줄."""
    out = adb("shell", "dumpsys", "audio")
    sec = out.split("RecordActivityMonitor", 1)[-1].split("\n\n", 1)[0] if "RecordActivityMonitor" in out else ""
    return [l.strip() for l in sec.splitlines() if PKG in l or "teampitcrew" in l]


def top():
    m = re.search(r"topResumedActivity=ActivityRecord\{\S+ \S+ (\S+)", adb("shell", "dumpsys", "activity", "activities"))
    return m.group(1) if m else None


def clock_offset():
    """기기 시계 − Mac 시계(ms). adb 왕복의 가운데로 잰다."""
    best = None
    for _ in range(5):
        a = time.time() * 1000; d = int(adb("shell", "date", "+%s%3N").strip()); b = time.time() * 1000
        if best is None or b - a < best[1]: best = (d - (a + b) / 2, b - a)
    note("clock", offset_ms=round(best[0]), rtt_ms=round(best[1]))
    return best[0]


samples = []
sampling = threading.Event()


def ticks(pid):
    st = adb("shell", "cat", f"/proc/{pid}/stat").split(")")[-1].split()
    return int(st[11]) + int(st[12]) if len(st) > 12 else None  # utime + stime(필드 14, 15)


def pss(pid):
    m = re.search(r"TOTAL PSS:\s+(\d+)", adb("shell", "dumpsys", "meminfo", pid))
    return int(m.group(1)) if m else None


def sampler():
    """30초마다 우리 프로세스와 Pleos STT 엔진(ai.pleos.playground.caas)의 CPU 틱과 PSS, 기기 전체 CPU 틱."""
    hz = int(adb("shell", "getconf", "CLK_TCK").strip() or 100); ncpu = int(adb("shell", "nproc").strip() or 4)
    note("device.cpu", hz=hz, cores=ncpu)
    while sampling.is_set():
        t = time.time(); row = {"t": time.strftime("%H:%M:%S"), "wall": t, "top": top()}
        row["total"] = sum(int(x) for x in adb("shell", "head", "-1", "/proc/stat").split()[1:8])
        for key, name in (("app", PKG), ("stt", "ai.pleos.playground.caas")):
            pid = adb("shell", "pidof", name).strip().split(" ")[0]
            row[key] = {"pid": pid, "ticks": ticks(pid), "pss_kb": pss(pid)} if pid else None
        samples.append(row); time.sleep(max(1, 30 - (time.time() - t)))
    note("device.cpu.done", samples=len(samples))
    return hz, ncpu


def usage(hz, ncpu):
    """구간마다 한 코어 기준 %와 기기 전체(코어 모두) 기준 %. Pleos 기준(5%)이 어느 쪽인지는 문서에 없다."""
    rows = []
    for a, b in zip(samples, samples[1:]):
        dt = b["wall"] - a["wall"]; dtot = b["total"] - a["total"]
        r = {"t": b["t"], "top": b["top"]}
        for k in ("app", "stt"):
            if a.get(k) and b.get(k) and a[k]["pid"] == b[k]["pid"] and a[k]["ticks"] is not None and b[k]["ticks"] is not None:
                d = b[k]["ticks"] - a[k]["ticks"]
                r[k] = {"core_pct": round(100 * d / (dt * hz), 2), "device_pct": round(100 * d / dtot, 2) if dtot else None, "pss_mb": round((b[k]["pss_kb"] or 0) / 1024, 1)}
        rows.append(r)
    return rows


# ---- 넣은 문장과 받아 적은 문장 ------------------------------------------------------------------------------
norm = lambda s: re.sub(r"[^0-9A-Za-z가-힣]", "", s)


def edits(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1): cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def compare(meta, t_inj, offset, got):
    """넣은 문장마다 그 시간에 걸친 발화를 모아 비교한다. 시각은 Mac 기준(기기 시각 − offset)."""
    rows = []
    for u in meta["utterances"]:
        s = t_inj + u["start_s"] * 1000; e = t_inj + u["end_s"] * 1000
        # 서버 기록에는 시작 시각만 있다(끝 시각은 차에만). 다음 발화의 시작을 끝 대신 쓰고 넣은 문장 구간과 겹치면 그 문장의 발화로 본다
        # (STT가 두 문장을 한 발화로 적어도 뒤 문장이 비지 않게)
        ends = {g["seq"]: n["at"] for g, n in zip(got, got[1:])}
        hit = [g for g in got if g["at"] - offset <= e + 1500 and ends.get(g["seq"], g["at"] + 6000) - offset >= s]
        text = " ".join(g["text"] for g in hit)
        n = norm(u["text"]); dist = edits(n, norm(text))
        rows.append({**u, "got": text, "seq": [g["seq"] for g in hit],
                     "char_acc": round(1 - dist / len(n), 3) if n else None,
                     "start_err_ms": round(hit[0]["at"] - offset - s) if hit else None})
    want = "".join(norm(u["text"]) for u in meta["utterances"]); have = "".join(norm(g["text"]) for g in got)
    total = round(1 - edits(want, have) / len(want), 4)
    with open(OUT / "transcript.tsv", "w") as f:
        f.write("넣은 시각(초)\t채널\t누가\t넣은 문장\t받아 적은 문장\t순번\t글자 일치\t시작 오차(ms)\n")
        for r in rows: f.write(f"{r['start_s']}\t{r['channel']}\t{r['who']}\t{r['text']}\t{r['got']}\t{','.join(map(str, r['seq']))}\t{r['char_acc']}\t{r['start_err_ms']}\n")
    return rows, total


def notice():
    """우리 앱 알림의 글자(dumpsys notification). 화면이 뒤에 있을 때 사용자가 볼 수 있는 표시."""
    out = adb("shell", "dumpsys", "notification", "--noredact")
    return " ".join(re.findall(r"android\.text=String \(([^)]*)\)", out.split(f"pkg={PKG}", 1)[1][:4000])) if f"pkg={PKG}" in out else ""


def save(code, offset, t_inj, total, rows, minutes):
    (OUT / "capture-log.json").write_text(json.dumps(capture_log, ensure_ascii=False, indent=1))
    (OUT / "results.json").write_text(json.dumps({"code": code, "minutes": minutes, "clock_offset_ms": round(offset), "inject_start_ms": t_inj,
                                                  "total_char_acc": total, "rows": rows, "log": e2e.log}, ensure_ascii=False, indent=1))


def wait_texts(pred, timeout):
    end = time.time() + timeout
    while time.time() < end:
        ui = texts()
        if pred(ui): return ui
        time.sleep(1)
    return texts()


def main(apk, minutes):
    threading.Thread(target=e2e.heartbeat, daemon=True).start()
    threading.Thread(target=logcat, daemon=True).start()
    inj = Injector()
    drive = fixture("drive", TALK, seconds=minutes * 60)
    for name, line in (("after", AFTER), ("again", AGAIN)): fixture(name, [line], tail=4.0)
    offset = clock_offset()
    sha = e2e.hashlib.sha256(open(apk, "rb").read()).hexdigest()
    note("apk", sha256=sha, size=pathlib.Path(apk).stat().st_size)
    # 같은 APK가 이미 깔려 있으면 다시 깔지 않는다. 바쁜 기기에서 설치하다 Watchdog이 system_server를 죽인 적이 있다(11/13 10:42)
    path = adb("shell", "pm", "path", "--user", "10", PKG).strip().removeprefix("package:")
    if not path or sha not in adb("shell", "sha256sum", path):
        note("install", out=subprocess.run(ADB + ["install", "--user", "10", "-r", "-g", apk], capture_output=True, text=True).stdout.strip()[-200:])
    if sha not in adb("shell", "sha256sum", adb("shell", "pm", "path", "--user", "10", PKG).strip().removeprefix("package:")):
        raise SystemExit("깔린 APK가 이번 빌드와 다릅니다")
    gear("Park")
    adb("shell", "am", "force-stop", "--user", "10", PKG)
    adb("shell", "pm", "clear", "--user", "10", PKG)
    for perm in ("RECORD_AUDIO", "POST_NOTIFICATIONS"): adb("shell", "pm", "grant", "--user", "10", PKG, f"android.permission.{perm}")
    adb("shell", "am", "start", "--user", "10", "-n", f"{PKG}/.MainActivity", "--es", "server", f"http://10.0.2.2:{PORT}")
    wait_texts(lambda u: e2e.SETUP in u, 30); e2e.tap_make(); time.sleep(4)  # 설치 직후 첫 화면은 바쁜 기기에서 4초를 넘기기도 함
    ui = texts(); code = next((t.split()[-1] for t in ui if t.startswith("여행 코드")), None); note("trip", code=code)
    # 1. 폰 참가자가 들어오고, 주차 중 동의: 차는 자기가 참가시킨 사람만 켜고, 폰이 자기 토큰으로 켜면 수음 시작(T68)
    phone = phone_join(code)
    wait_texts(lambda u: "일행 5명" in u, 15); tap_switch()
    mine = lambda t: [p["consent"] for p in t["participants"] if p["id"] != phone[0]]
    for _ in range(10):  # 폰 참가자는 들어오자마자 '동의 대기'라 화면이 아니라 서버로 차의 켜기가 끝났는지 본다
        t = server(code)
        if all(mine(t)): break
        time.sleep(1)
    ui = texts(); shot("01a-phone-waits"); note("ui", texts=ui)
    check("차의 기록 시작은 차가 참가시킨 4명만 켜고, 폰 참가자는 동의 대기(기록 안 함)",
          all(mine(t)) and len(mine(t)) == 4 and not next(p for p in t["participants"] if p["id"] == phone[0])["consent"]
          and "동의 대기" in ui and "● 기록 중" not in ui)  # 좌석 지도에서 이름과 동의는 따로(T20)
    phone_consent(code, phone, True)
    ui = wait_texts(lambda u: "● 기록 중" in u, 15); shot("01-recording-park"); note("ui", texts=ui)
    held = mic_holders(); note("mic", holders=held)
    started = [c["line"] for c in capture_log if c["line"].startswith("녹음 시작")]
    if not check("P에서 동의를 켜면 기록 중, 마이크를 쥠(16 kHz 2채널)", "● 기록 중" in ui and held and any("16000 Hz 2채널" in l for l in started), log=started):
        raise SystemExit("수음이 열리지 않아 소리를 넣지 않고 멈춥니다(아무도 녹음하지 않을 때 넣으면 에뮬레이터가 멈춘 적이 있음)")
    # 2. 내비를 앞에, 기어 D, 가족 대화를 넣음
    adb("shell", "am", "start", "--user", "10", "-n", NAVI); time.sleep(4)
    gear("Drive")
    try: urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8088/vehicle/controls?speed=40&accelerator=0&brake=0", method="PUT"), timeout=5).read()
    except Exception as ex: note("speed", error=str(ex)[:100])
    shot("02-navi-front-drive"); note("top", activity=top())
    check("내비가 앞에 있음", "navigation" in (top() or ""))
    sampling.set(); res = {}
    th = threading.Thread(target=lambda: res.update(zip(("hz", "ncpu"), sampler())), daemon=True); th.start()
    log0 = len(capture_log)
    t_inj = inj.play("drive")
    time.sleep(5)
    sampling.clear(); th.join(60)
    window = capture_log[log0:]
    # 서버 기록: 보관함의 발화가 빠짐없이 올라갔는지(10초 조회마다). 위치는 내비가 알려 준 만큼(에뮬레이터는 판교에 머묾)
    n_local = lines(code)
    up = wait_uploaded(code, phone, n_local); got = sorted(up["items"], key=lambda u: u["seq"]); gen0 = up["generation"]
    (OUT / "uploaded.json").write_text(json.dumps(up, ensure_ascii=False, indent=1))
    rows, total = compare(drive, t_inj, offset, got)
    first5 = rows[:5]
    note("compare", total_char_acc=total, utterances=len(got), lines=len(rows))
    check("다섯 문장이 내비를 앞에 둔 기어 D에서 보관함과 서버 기록에 남음", all(r["seq"] for r in first5), rows=[(r["text"], r["got"], r["char_acc"]) for r in first5])
    check("보관함의 발화가 모두 서버에 올라감(순번 1부터 빠짐없이)", [u["seq"] for u in got] == list(range(1, n_local + 1)), local=n_local, server=len(got),
          generation=gen0, with_place=sum("lat" in u for u in got), devices=sorted({u["device"] for u in got}))
    raw = vault(code)
    check("차 안 보관함·상태 파일·저장한 여행에 평문이 없음(받아 적은 글, 순번, 위치, 이름)",
          raw and not any(u["text"][:5] in raw for u in got if len(u["text"]) >= 5) and not any(x in raw for x in ('"seq"', '"lat"', "아빠", "participants")), bytes=len(raw))
    check(f"{minutes}분 동안 막힘 없음(수음 상태 줄에 BLOCKED·녹음 끝 없음)", not any("BLOCKED" in c["line"] or "녹음 끝" in c["line"] for c in window), lines=[c["line"] for c in window][:20])
    check("주행 구간 내내 내비가 앞", all("navigation" in (s["top"] or "") for s in samples), tops=sorted({s["top"] or "" for s in samples}))
    use = usage(res.get("hz", 100), res.get("ncpu", 4)); (OUT / "resources.json").write_text(json.dumps({"samples": samples, "usage": use}, ensure_ascii=False, indent=1))
    note("usage", rows=use)
    # 3. 주행 중 화면 트리(차단 화면에 가려 캡처로는 안 보임), 그다음 P에서 앱을 앞으로
    adb("shell", "am", "start", "--user", "10", "-n", f"{PKG}/.MainActivity"); time.sleep(3)
    shot("03-app-drive-blocked"); ui = texts(); note("ui", texts=ui)
    check("기어 D에서 앱을 앞으로: 화면 트리에 받아 적은 말(캡처는 Pleos 차단 화면)", "방금 받아 적은 말" in ui)
    gear("Park"); time.sleep(3)
    shot("04-app-park-heard"); ui = texts(); note("ui", texts=ui)
    last = got[-1]["text"] if got else "?"
    check("P에서 기록 중과 방금 받아 적은 말이 보임", "● 기록 중" in ui and any(last in t for t in ui), last=last)
    # 4. 화면 뒤에서 막힘: 내비가 앞일 때 시스템 마이크 차단(센서 개인정보 보호)을 켠다. 시스템이 우리 녹음을 막는다(isClientSilenced).
    #    앱 권한 ops(appops RECORD_AUDIO ignore·deny)로는 이미 열린 녹음이 막히지 않았다(11/13 11:08 시험).
    #    막힌 동안에는 소리를 넣지 않는다. 에뮬레이터가 소리를 당겨 가지 않으면 넣기가 끝나지 않을 수 있다
    adb("shell", "am", "start", "--user", "10", "-n", NAVI); time.sleep(3)
    log1 = len(capture_log)
    adb("shell", "cmd", "sensor_privacy", "enable", "10", "microphone"); t_block = time.time()
    try:
        time.sleep(4)
        held = mic_holders(); n_text = notice()
        note("blocked.behind", top=top(), holders=held, notification=n_text, log=[c["line"] for c in capture_log[log1:]])
        check("화면 뒤(내비가 앞)에서 막히면 기록 멈춤(앱 상태 줄과 알림)", any("BLOCKED" in c["line"] for c in capture_log[log1:]) and "기록 멈춤" in n_text,
              silenced=[l.split("silenced:")[1].split()[0] for l in held if "silenced:" in l])
        adb("shell", "am", "start", "--user", "10", "-n", f"{PKG}/.MainActivity")
        ui = wait_texts(lambda u: "기록 멈춤" in u, 8); shot("05-blocked"); note("ui", texts=ui)
        check("앱을 열면 기록 멈춤이 보임", "기록 멈춤" in ui)
        n0 = lines(code)
    finally:
        adb("shell", "cmd", "sensor_privacy", "disable", "10", "microphone")
    ui = wait_texts(lambda u: "● 기록 중" in u, 10); shot("06-unblocked"); note("ui", texts=ui)
    on = [c for c in capture_log[log1:] if c["line"].startswith("수음 ")]
    check("막힘이 풀리면 기록 중", "● 기록 중" in ui, log=[(round((c["device_ms"] - offset) / 1000 - t_block, 2), c["line"]) for c in on])
    inj.play("after"); time.sleep(3)
    new = [u for u in wait_uploaded(code, phone, lines(code))["items"] if u["seq"] > n0]
    check("풀린 뒤에 넣은 말은 다시 적힘", any(edits(norm(AFTER[1]), norm(g["text"])) <= 4 for g in new), got=[g["text"] for g in new])
    # 5. 동의 끄기: 바로 멈추고 마이크를 놓는다
    log2 = len(capture_log); t_off = time.time(); tap_switch()
    gone = None
    for _ in range(50):
        if not mic_holders(): gone = round(time.time() - t_off, 2); break
        time.sleep(0.1)
    time.sleep(1); shot("07-off"); ui = texts(); note("ui", texts=ui)
    svc = adb("shell", "dumpsys", "activity", "services", PKG)
    # 앱 기록의 시각(기기 시계 − offset)으로 누름부터 '수음 OFF'·'녹음 끝'까지. dumpsys audio 확인은 한 번에 1초 안팎 걸려 상한만 준다
    stops = [(round((c["device_ms"] - offset) / 1000 - t_off, 2), c["line"]) for c in capture_log[log2:]]
    check("동의를 끄면 바로 멈추고 마이크를 놓음", "기록 꺼짐" in ui and gone is not None and "CaptureService" not in svc, mic_gone_by_dumpsys_s=gone, log=stops)
    save(code, offset, t_inj, total, rows, minutes)
    for _ in range(15):  # 끄기를 서버에 알린 뒤 받은 여행의 동의 세대로 옛 발화의 글을 지운다(ADR-0014 2절). 다음 조회까지 걸릴 수 있다
        ui = texts()
        if "기록 꺼짐" in ui and "아직 받아 적은 말이 없어요" in ui: break
        time.sleep(1)
    note("ui", texts=ui)
    check("동의를 끄면 보관함의 글이 빔(대화록 칸이 '아직 받아 적은 말이 없어요', 순번 줄은 남음)", "기록 꺼짐" in ui and "아직 받아 적은 말이 없어요" in ui and lines(code) >= n_local,
          lines=lines(code))
    try:
        t = server(code)
        check("서버의 동의도 꺼짐", not any(p["consent"] for p in t["participants"]))
    except Exception as ex:
        check("서버의 동의도 꺼짐", False, error=str(ex)[:200])
    # 6. 앱을 다시 켜도 보관함과 순번이 이어진다
    before = lines(code)
    adb("shell", "am", "force-stop", "--user", "10", PKG)
    adb("shell", "am", "start", "--user", "10", "-n", f"{PKG}/.MainActivity"); time.sleep(5)
    ui = texts(); shot("08-restart"); note("ui", texts=ui)
    check("앱을 다시 켜도 보관함(글을 지운 순번 포함)이 남음", lines(code) == before and any(t.startswith("여행 코드") for t in ui), lines=before)
    tap_switch(); wait_texts(lambda u: "동의 대기" in " ".join(u), 10)
    phone_consent(code, phone, True); wait_texts(lambda u: "● 기록 중" in u, 15)
    inj.play("again"); time.sleep(3)
    up = wait_uploaded(code, phone, lines(code) - before)
    check("다시 켠 뒤의 발화는 순번이 이어지고 새 동의 세대이며, 그것만 서버에 남음(옛 세대는 서버가 지움)",
          sorted(u["seq"] for u in up["items"])[:1] == [before + 1] and up["generation"] > gen0, server=[u["seq"] for u in up["items"]], generation=(gen0, up["generation"]))
    tap_switch(); time.sleep(2)
    gear("Park")
    save(code, offset, t_inj, total, rows, minutes)
    # 7. 보관 기간(T69): 시험용으로 보관 기간을 1분으로 줄여 다시 켜면(디버그 빌드의 --el keepMs) 이 여행의 차 안 사본이 사라지고 처음 화면
    had = trip_files(code)
    adb("shell", "am", "start", "--user", "10", "-S", "-n", f"{PKG}/.MainActivity", "--el", "keepMs", "60000"); time.sleep(5)
    ui = texts(); shot("09-expired"); note("ui", texts=ui)
    check("만든 뒤 보관 기간이 지난 여행은 다시 켤 때 차 안 사본(보관함·할 일·저장한 여행)이 지워짐", had and not trip_files(code) and e2e.making(ui), had=had)
    # 8. 서버에서 여행을 명시적으로 지우면(404) 차 안 사본도 지운다. 새 여행을 만들고 서버 DB에서 지운다
    adb("shell", "am", "start", "--user", "10", "-S", "-n", f"{PKG}/.MainActivity"); time.sleep(4)
    e2e.tap_make(); time.sleep(4)
    ui = texts(); code2 = next((t.split()[-1] for t in ui if t.startswith("여행 코드")), None); had = trip_files(code2) if code2 else []
    pg = os.environ.get("GACHITA_PG", "gachita-pg")
    out = subprocess.run(["docker", "exec", pg, "psql", "-U", "gachita", "-tAc", f"DELETE FROM trips WHERE code = '{code2}'"], capture_output=True, text=True)
    note("server.delete", code=code2, out=(out.stdout + out.stderr).strip()[:100])
    ui = wait_texts(lambda u: e2e.making(u), 20); shot("10-gone"); note("ui", texts=ui)
    check("서버가 여행을 모르면(404) 차 안 사본을 지우고 처음 화면에 알림", had and not trip_files(code2) and "서버에 없는 여행이라 이 차에 남은 기록도 지웠어요" in ui, code=code2, had=had)
    fails = [e["name"] for e in e2e.log if e["step"] == "check" and not e["ok"]]
    print("실패:", fails if fails else "없음")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main(sys.argv[1], float(sys.argv[3]) if len(sys.argv) > 3 else 10)
