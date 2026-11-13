"""Gleo와 마이크 주고받기 E2E(T41): 호출어 → 수음 멈춤 → 운전대 버튼(대역) → Gleo 듣기 → Gleo 끝 → 다시 수음 → 이어지는 전사.

준비: capture_e2e.py와 같다(make run, -grpc 8556 -grpc-use-token -audio none으로 Cold boot한 에뮬레이터, adb forward tcp:8088 tcp:8088,
      ./gradlew assembleDebug). 넣는 소리는 macOS say(Yuna) 합성 음성이다.
실행: python3 frontend/car/gleo_e2e.py frontend/car/app/build/outputs/apk/debug/app-debug.apk <저장소 밖 폴더>

순서: 여행 만들기 → P에서 동의 켬 → 기어 D, 우리 화면이 앞
      1. "글레오" → '기록 잠시 멈춤 · 운전대 버튼을 누르세요' → 운전대 버튼 대신 `cmd voiceinteraction show` → Gleo가 듣고 잠듦
         → 포커스가 돌아오면 다시 수음 → 이어 넣은 말이 받아 적힘
      2. "클레오"(STT가 흔히 적는 꼴) → 버튼을 누르지 않음 → 15초 뒤 저절로 다시 수음, 버튼 없이 시간 초과로 셈
      3. 화면의 'Gleo 쓰기' → 같은 멈춤 → 시간 초과로 다시 수음
      4. Gleo 함수(assets/schema.json)를 Gleo와 같은 인텐트로: 기록 멈추기 → 마이크를 놓고 '기록 멈춤'(동의는 그대로) → 다시 시작 → 기록 중
- 운전대 버튼은 사람 손이라 `cmd voiceinteraction show`로 대신한다(11/13 실측과 같음). Gleo가 실제로 알아듣는지는 보지 않는다.
- Gleo가 듣는 동안에는 소리를 넣지 않는다. 우리 앱이 수음한 적이 있는 부팅에서 그때 넣자 에뮬레이터가 멈췄다(docs/emulator/e2e-flow.md).
- 호출어는 실시간 모드로 0.1초마다 보내고 끝에 쉼을 두지 않는다. 기본 모드는 앱이 마이크를 놓은 뒤에도 남은 소리를 붙들고
  다시 녹음할 때까지 기다렸다(11/14 1회차, 15초). 넣는 동안 입력이 닫혔다 열리면 에뮬레이터가 멈춘 적이 있어(11/13 09:03) 피한다.
  넣기가 앱이 마이크를 놓기 전에 끝났는지 매번 본다.
- 결과는 OUT/results.json, 앱 로그(글자 없음)는 OUT/app-log.json.
"""
import json, re, subprocess, sys, threading, time, wave
import e2e, capture_e2e as cap
from e2e import ADB, PKG, OUT, adb, shot, texts, tap_text, tap_switch, gear, check, note

PORT = cap.PORT
WAKE = ("아빠", "글레오")
WAKE2 = ("엄마", "글레오")  # "클레오"로 넣으면 STT가 "그리고"로 적었다(11/14 1회차)
AFTER = ("딸", "휴게소에서 아이스크림 먹고 싶어")  # 호출어가 든 말은 또 넘긴다(1회차 "글레오랑 …"을 STT가 "클리오란 …"으로 적음)
app_log = []


def logcat():
    """앱의 흐름 줄(GachitaGleo·GachitaCapture·GachitaAsk). 앱은 받아 적은 글자를 로그에 남기지 않는다."""
    adb("logcat", "-c")
    p = subprocess.Popen(ADB + ["logcat", "-v", "epoch", "GachitaGleo:I", "GachitaCapture:I", "GachitaAsk:I", "*:S"],
                         stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    for line in p.stdout:
        m = re.match(r"\s*(\d+)\.(\d+)\s.*?(Gachita\w+):\s(.*)", line)
        if m: app_log.append({"device_ms": int(m.group(1)) * 1000 + int(m.group(2)), "tag": m.group(3), "line": m.group(4).strip()})


def wait_log(pattern, since, timeout):
    end = time.time() + timeout
    while time.time() < end:
        for e in app_log[since:]:
            if re.search(pattern, e["line"]): return e
        time.sleep(0.2)
    return None


def ours_recording():
    """시스템 녹음 목록에서 우리 녹음이 지금 도는지. 멈춘(stop) 녹음도 release 전까지 'active? false'로 남아 그 줄로 가린다."""
    sec = adb("shell", "dumpsys", "audio").split("RecordActivityMonitor", 1)[-1].split("Events log", 1)[0]
    return any(g.startswith("riid") and "active? true" in g.splitlines()[0] and PKG in g and "silenced:false" in g for g in re.split(r"\n(?=riid )", sec))


def play_now(inj, name):
    """앱이 곧바로 마이크를 놓는 소리. 실시간 모드로 0.1초마다 보내 말이 끝나면 넣기도 끝나게 한다. 끝난 시각(Mac ms)을 돌려준다."""
    if not ours_recording(): raise SystemExit(f"우리 녹음이 열려 있지 않아 '{name}'을 넣지 않고 멈춥니다")
    w = wave.open(str(OUT / "inputs" / f"{name}.wav"), "rb")
    end = int(json.loads((OUT / "inputs" / f"{name}.json").read_text())["utterances"][-1]["end_s"] * cap.R)  # fixture가 말 뒤에 붙인 쉼은 보내지 않는다
    pb = inj.pb
    fmt = pb.AudioFormat(samplingRate=cap.R, channels=pb.AudioFormat.Stereo, format=pb.AudioFormat.AUD_FMT_S16, mode=pb.AudioFormat.MODE_REAL_TIME)
    def packets():
        t0 = time.time()
        for i in range(0, end, cap.R // 10):
            time.sleep(max(0, t0 + i / cap.R - time.time()))
            yield pb.AudioPacket(format=fmt, timestamp=time.time_ns() // 1000, audio=w.readframes(min(cap.R // 10, end - i)))
    note("inject.start", name=name, mode="real-time")
    try: inj.stub.injectAudio(packets(), metadata=inj.md, timeout=30); res = "completed"
    except inj.grpc.RpcError as e: res = e.code().name
    done = int(time.time() * 1000); note("inject.done", name=name, result=res)
    return done


def gleo_call(fn):
    """Gleo가 함수를 부를 때와 같은 인텐트(component activity, action은 '<패키지>.<함수 이름>')."""
    adb("shell", "am", "start", "--user", "10", "-n", f"{PKG}/.MainActivity", "-a", f"{PKG}.{fn}")
    note("gleo.call", fn=fn)


def main(apk):
    threading.Thread(target=e2e.heartbeat, daemon=True).start()
    threading.Thread(target=logcat, daemon=True).start()
    inj = cap.Injector()
    cap.fixture("wake", [WAKE], lead=0.5, tail=0.0)
    cap.fixture("wake2", [WAKE2], lead=0.5, tail=0.0)
    offset = cap.clock_offset()
    cap.fixture("after", [AFTER], tail=4.0)
    note("apk", sha256=e2e.hashlib.sha256(open(apk, "rb").read()).hexdigest())
    note("install", out=subprocess.run(ADB + ["install", "--user", "10", "-r", "-g", apk], capture_output=True, text=True).stdout.strip()[-120:])
    gear("Park")
    adb("shell", "am", "force-stop", "--user", "10", PKG); adb("shell", "pm", "clear", "--user", "10", PKG)
    for perm in ("RECORD_AUDIO", "POST_NOTIFICATIONS"): adb("shell", "pm", "grant", "--user", "10", PKG, f"android.permission.{perm}")
    adb("shell", "am", "start", "--user", "10", "-n", f"{PKG}/.MainActivity", "--es", "server", f"http://10.0.2.2:{PORT}")
    time.sleep(4); tap_text("여행 만들기"); time.sleep(4)
    ui = texts(); code = next((t.split()[-1] for t in ui if t.startswith("여행 코드")), None); note("trip", code=code)
    tap_switch()
    ui = cap.wait_texts(lambda u: "● 기록 중" in u, 10)
    if not check("P에서 동의를 켜면 기록 중", "● 기록 중" in ui and ours_recording()):
        raise SystemExit("수음이 열리지 않아 소리를 넣지 않고 멈춥니다")
    gear("Drive"); time.sleep(2)

    # 1. 호출어 → 멈춤 → 버튼(대역) → Gleo → 다시 수음 → 이어지는 전사
    k = len(app_log); done = play_now(inj, "wake")
    e = wait_log(r"^Gleo에게 넘김 호출어", k, 10)
    ui = texts(); shot("1-wake-paused"); note("ui", texts=ui)
    note("focus", owners=[l.split("-- client")[0].strip() + " " + l.split("gain:")[1][:60] for l in adb("shell", "dumpsys", "audio").splitlines() if "pack: " in l and "gain:" in l])
    check("넣기가 앱이 마이크를 놓기 전에 끝남", e and done < e["device_ms"] - offset, gap_ms=e and round(e["device_ms"] - offset - done))
    check("호출어로 수음만 멈춤(서비스 유지) · 화면 '기록 잠시 멈춤 · 운전대 버튼을 누르세요'",
          e and "기록 잠시 멈춤" in ui and "운전대 버튼을 누르세요" in ui and wait_log(r"^녹음 잠시 멈춤", k, 3) and not ours_recording(), line=e and e["line"])
    time.sleep(1)
    adb("shell", "cmd", "voiceinteraction", "show"); note("ptt", how="cmd voiceinteraction show")
    g = wait_log(r"^Gleo 들음", k, 10)
    ui = texts(); note("ui", texts=ui)
    check("Gleo가 들으면 우리가 포커스를 잃음(LOSS_TRANSIENT) · 'Gleo가 끝나면 다시 기록해요'", g and "Gleo가 끝나면 다시 기록해요" in ui, line=g and g["line"])
    b = wait_log(r"^다시 수음\(Gleo 끝\)", k, 40)  # Gleo가 말 없이 잠들 때까지(11/13 약 5초). 그동안 소리를 넣지 않는다
    check("Gleo가 잠들면 포커스가 돌아와 다시 수음", b and wait_log(r"^녹음 다시 시작", k, 3), line=b and b["line"])
    time.sleep(1); ui = texts(); shot("1-resumed")
    check("다시 '● 기록 중'이고 마이크를 쥠", "● 기록 중" in ui and ours_recording())
    if not ours_recording(): raise SystemExit("마이크가 열리지 않아 소리를 넣지 않고 멈춥니다")
    n = len(cap.outbox(code)); inj.play("after")  # 다시 연 우리 녹음에 넣는다(기본 모드); time.sleep(3)
    got = [u["text"] for u in cap.outbox(code)[n:]]
    check("다시 수음한 뒤 이어 넣은 말이 받아 적힘", any("아이스크림" in cap.norm(x) or "휴게소" in cap.norm(x) for x in got), heard=got)

    # 2. 다른 꼴의 호출어 → 버튼을 누르지 않음 → 시간 초과로 다시 수음
    k = len(app_log); done = play_now(inj, "wake2")
    e = wait_log(r"^Gleo에게 넘김 호출어", k, 10)
    b = wait_log(r"^다시 수음\(시간 초과\)", k, 25)
    check("버튼이 없으면 15초 뒤 저절로 다시 수음", e and b and ours_recording() and done < e["device_ms"] - offset, line=b and b["line"])

    # 3. 화면의 'Gleo 쓰기'
    k = len(app_log); tap_text("Gleo 쓰기")
    e = wait_log(r"^Gleo에게 넘김 단추", k, 5)
    ui = texts(); shot("3-button-paused")
    b = wait_log(r"^다시 수음\(시간 초과\)", k, 25)
    check("'Gleo 쓰기'로도 같은 멈춤과 재개", e and "운전대 버튼을 누르세요" in ui and b and ours_recording(), line=b and b["line"])
    counts = [x["line"] for x in app_log if x["line"].startswith("다시 수음")]
    note("counts", lines=counts)
    check("잘못 알아챈 횟수를 셈(호출어 2회 중 Gleo 1회 · 버튼 없이 시간 초과 1회)", counts and "호출어 2회 중 Gleo 1회 · 버튼 없이 시간 초과 1회" in counts[-1])

    # 4. Gleo 함수: 기록 멈추기 → 다시 시작(동의는 그대로)
    k = len(app_log); gleo_call("GACHITA_PAUSE_RECORDING"); time.sleep(3)
    ui = texts(); shot("4-gleo-paused")
    check("기록 멈추기: 마이크를 놓고 '기록 멈춤', 동의는 그대로", "기록 멈춤" in ui and "다시 기록" in ui and not ours_recording()
          and wait_log(r"^Gleo 응답 GACHITA_PAUSE_RECORDING success", k, 3) and all(p["consent"] for p in cap.server(code)["participants"]))
    k = len(app_log); gleo_call("GACHITA_RESUME_RECORDING"); time.sleep(4)
    ui = texts(); shot("4-gleo-resumed")
    check("다시 시작: '● 기록 중'과 마이크", "● 기록 중" in ui and ours_recording() and wait_log(r"^Gleo 응답 GACHITA_RESUME_RECORDING success", k, 3))

    gear("Park")
    (OUT / "app-log.json").write_text(json.dumps(app_log, ensure_ascii=False, indent=1))
    (OUT / "results.json").write_text(json.dumps(e2e.log, ensure_ascii=False, indent=1))
    fails = [x for x in e2e.log if x["step"] == "check" and not x["ok"]]
    print(f"검사 {sum(1 for x in e2e.log if x['step'] == 'check')}개 중 실패 {len(fails)}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main(sys.argv[1])
