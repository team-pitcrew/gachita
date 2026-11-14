"""부탁을 경유지로 E2E(T9): 가상 마이크에 넣은 부탁과 답으로 차량 앱이 제안하고, 수락하면 순정 내비에 경유지가 들어가는지 본다.

준비: capture_e2e.py와 같다(make run, -grpc 8556 -grpc-use-token -audio none으로 Cold boot한 에뮬레이터, adb forward tcp:8088 tcp:8088,
      ./gradlew assembleDebug). 넣는 소리는 macOS say(Yuna) 합성 음성이다.
실행: python3 frontend/car/waypoint_e2e.py frontend/car/app/build/outputs/apk/debug/app-debug.apk <저장소 밖 폴더> [시도 수]

순서: 앱이 내비에 강릉역 경로를 넣음(--es route) → 여행 만들기 → P에서 동의 켬 → 기어 D, 우리 화면이 앞
      → [시도 수]번: "화장실 가고 싶어" 류 → 제안(카드와 TTS) → "아니, 나중에 갈게" → 보관(부탁하는 말 끝 → 제안까지 시간).
        마지막 시도는 모호한 말 → 다시 물음 → 화면의 '나중에' 단추
      → 부탁 둘("화장실 가고 싶어", "나도 화장실 갈래") → 폰에서 첫째를 취소 → "응, 다음 휴게소 가자" → 경유지를 넣는 동안 셋째("나도 화장실 급해")
      → 둘째와 셋째만 reflected, 새 제안은 뜨지 않음.
- 지나친 휴게소 건너뛰기는 여기서 보지 않는다(AsksTest). 경로 안내 중인 내비의 지금 위치는 에뮬레이터 GPS를 옮겨도(gRPC setGps) 판교에 머물렀다(11/13).
- 결과는 OUT/results.json, 앱 로그(글자 없음)는 OUT/app-log.json, 2번 장면의 화면 녹화는 OUT/waypoint.webm.
"""
import json, re, shlex, statistics, subprocess, sys, threading, time, urllib.request
import e2e, capture_e2e as cap
from e2e import ADB, PKG, OUT, adb, shot, texts, tap_text, tap_switch, gear, check, note

PORT = cap.PORT
TRIES = int(sys.argv[3]) if len(sys.argv) > 3 else 8
ASKS = ["화장실 가고 싶어", "나 배고파", "엄마 화장실 급해", "조금 쉬었다 가자"]
NO = ("아빠", "아니, 나중에 갈게")
UNCLEAR = ("아빠", "바다는 언제 보여?")
GANGNEUNG = "37.7645236,128.8996276,강릉역"  # 앱에 --es route로 넘기는 목적지(위도,경도,이름)
YES = ("아빠", "응, 다음 휴게소 가자")
app_log = []


def logcat():
    """앱의 흐름 줄(GachitaAsk·GachitaCar·GachitaCapture). 앱은 받아 적은 글자를 로그에 남기지 않는다."""
    adb("logcat", "-c")
    p = subprocess.Popen(ADB + ["logcat", "-v", "epoch", "GachitaAsk:I", "GachitaCar:I", "GachitaCapture:I", "*:S"],
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


def trip(code):
    return json.load(urllib.request.urlopen(f"http://localhost:{PORT}/api/trips/{code}", timeout=5))


def cancel_from_phone(code, rid):
    """폰 웹앱의 '취소'와 같은 요청."""
    req = urllib.request.Request(f"http://localhost:{PORT}/api/trips/{code}/requests/{rid}", data=json.dumps({"status": "cancelled"}).encode(),
                                 headers={"Content-Type": "application/json"}, method="PATCH")
    urllib.request.urlopen(req, timeout=5).read(); note("phone.cancel", id=rid)


def heard_after(code, n):
    """보관함에서 n번째 뒤로 받아 적은 말."""
    return [g["text"] for g in cap.outbox(code)[n:]]


REQUEST_WORDS = ("화장실", "쉬었다가", "쉬어가", "배고파")  # Asks.kt isRestRequest와 같은 낱말


def front_app():
    adb("shell", "am", "start", "--user", "10", "-n", f"{PKG}/.MainActivity"); time.sleep(2)


def main(apk):
    threading.Thread(target=e2e.heartbeat, daemon=True).start()
    threading.Thread(target=logcat, daemon=True).start()
    inj = cap.Injector()
    for i, a in enumerate(ASKS): cap.fixture(f"ask{i}", [("아들", a)], tail=4.0)
    for name, line in (("no", NO), ("yes", YES), ("unclear", UNCLEAR), ("ask-b", ("딸", "나도 화장실 갈래")), ("ask-c", ("아들", "나도 화장실 급해"))):
        cap.fixture(name, [line], tail=4.0)
    offset = cap.clock_offset()
    note("apk", sha256=e2e.hashlib.sha256(open(apk, "rb").read()).hexdigest())
    note("install", out=subprocess.run(ADB + ["install", "--user", "10", "-r", "-g", apk], capture_output=True, text=True).stdout.strip()[-120:])
    gear("Park")
    adb("shell", "am", "force-stop", "--user", "10", PKG); adb("shell", "pm", "clear", "--user", "10", PKG)
    for perm in ("RECORD_AUDIO", "POST_NOTIFICATIONS"): adb("shell", "pm", "grant", "--user", "10", PKG, f"android.permission.{perm}")
    n0 = len(app_log)
    adb("shell", "am", "start", "--user", "10", "-n", f"{PKG}/.MainActivity", "--es", "server", f"http://10.0.2.2:{PORT}", "--ez", "onboarding", "false", "--es", "route", shlex.quote(GANGNEUNG))
    check("앱이 내비에 강릉역 경로를 넣음(onRouteStarted)", wait_log("경로 시작 강릉역", n0, 30))
    time.sleep(2); front_app(); e2e.tap_make(); time.sleep(4)
    ui = texts(); code = next((t.split()[-1] for t in ui if t.startswith("여행 코드")), None); note("trip", code=code)
    tap_switch()
    ui = cap.wait_texts(lambda u: "● 기록 중" in u, 10)
    if not check("P에서 동의를 켜면 기록 중", "● 기록 중" in ui and cap.mic_holders()):
        raise SystemExit("수음이 열리지 않아 소리를 넣지 않고 멈춥니다")
    gear("Drive")
    try: urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8088/vehicle/controls?speed=80&accelerator=20&brake=0", method="PUT"), timeout=5).read()
    except Exception as ex: note("speed", error=str(ex)[:100])

    # 1. 부탁하는 말이 끝난 뒤 제안이 뜨기까지(Mac 시계). 답은 '나중에'로 보관
    lat = []; missed = []
    for i in range(TRIES):
        name = f"ask{i % len(ASKS)}"; meta = json.loads((OUT / "inputs" / f"{name}.json").read_text())
        n = len(cap.outbox(code)); k = len(app_log); t0 = inj.play(name)
        e = wait_log(r"^제안 ", k, 15)
        got = heard_after(code, n); is_req = any(w in cap.norm(g) for g in got for w in REQUEST_WORDS)
        end_mac = t0 + meta["utterances"][0]["end_s"] * 1000
        if e: lat.append(round((e["device_ms"] - offset - end_mac) / 1000, 2))
        elif not is_req: missed.append(got)  # 받아쓰기가 부탁 낱말을 놓침(규칙이 아니라 STT 쪽)
        note("propose", try_=i + 1, said=meta["utterances"][0]["text"], heard=got, line=e and e["line"], after_speech_end_s=lat[-1] if e else None)
        if not e and not is_req: continue
        if i == 0:
            check("제안을 말(TTS)로도 알림", e and wait_log(r"^말함 \d+자$", app_log.index(e), 2))
            shot("01-offer-drive"); note("ui", texts=texts())
        if i < TRIES - 1:
            k = len(app_log); inj.play("no")
            check(f"시도 {i + 1}: 말로 '나중에' → 보관", wait_log(r"부탁 1/1건 held", k, 15))
        else:  # 모호한 말에는 한 번 다시 묻고, 화면 단추로도 답한다
            k = len(app_log); inj.play("unclear")
            u = wait_log(r"^발화 ", k, 12)  # 모호한 말이 받아 적힌 뒤에 나온 '말함'만 센다
            check(f"시도 {i + 1}: 모호한 말에는 다시 물음(보관하지 않음)", u and wait_log(r"^말함 \d+자$", app_log.index(u), 3) and not wait_log(r"held", k, 0.1))
            k = len(app_log); tap_text("나중에")
            check(f"시도 {i + 1}: 화면의 '나중에' → 보관", wait_log(r"부탁 1/1건 held", k, 10))
    p95 = sorted(lat)[max(0, round(0.95 * len(lat)) - 1)] if lat else None
    note("latency", seconds=lat, median=statistics.median(lat) if lat else None, p95=p95, n=len(lat))
    note("stt.missed", count=len(missed), heard=missed)
    check(f"부탁 낱말이 받아 적힌 {TRIES - len(missed)}번 모두 제안, p95 {p95}초 ≤ 5초(기준 문서 목표)", len(lat) == TRIES - len(missed) and p95 is not None and p95 <= 5, seconds=lat)

    # 2. 부탁 둘 → 하나는 폰에서 취소 → 수락 → 남은 하나만 경유지로
    video = str((OUT / "waypoint.webm").resolve())
    subprocess.run(ADB + ["emu", "screenrecord", "start", video])  # 에뮬레이터가 Mac 쪽 경로에 쓴다
    k = len(app_log); inj.play("ask0")
    check("부탁 A → 제안", wait_log(r"^제안 ", k, 15) and wait_log(r"부탁 1/1건 proposed", k, 10))
    k = len(app_log); inj.play("ask-b")
    check("부탁 B는 같은 제안에 묶임", wait_log(r"^부탁 보관", k, 15) and wait_log(r"부탁 1/1건 proposed", k, 10) and not wait_log(r"^제안 ", k, 0.1))
    time.sleep(1); shot("02-offer-two"); note("ui", texts=texts())
    reqs = [r for r in trip(code)["requests"] if r["status"] == "proposed"]
    check("서버에 proposed 부탁 둘", len(reqs) == 2, reqs=[(r["text"], r["status"]) for r in reqs])
    cancel_from_phone(code, reqs[0]["id"])
    k = len(app_log); t_yes = inj.play("yes")
    acc = wait_log(r"부탁 \d/2건 accepted", k, 15); req = wait_log(r"^경유지 요청", k, 15)
    k2 = len(app_log); inj.play("ask-c")  # 내비가 앞으로 나와 경유지를 넣는 동안 들어온 부탁
    added = wait_log(r"경유지 ADD", k, 40); done = wait_log(r"^경유지 (반영|실패)", k, 40)
    joined = wait_log(r"^부탁 보관", k2, 15)
    check("넣는 동안 들어온 부탁은 같은 제안에 묶이고 새 제안은 뜨지 않음", joined and not wait_log(r"^제안 ", k2, 0.1))
    note("waypoint", accepted=acc and acc["line"], request=req and req["line"], navi=added and added["line"], done=done and done["line"],
         yes_to_callback_s=round((added["device_ms"] - offset - t_yes) / 1000, 2) if added else None)
    check("수락: 취소된 A는 빠지고 B만 accepted", acc and "1/2건" in acc["line"])
    check("onWaypointChanged(ADD)를 받고 반영, 반영 뒤 말로 알림", added and done and "반영" in done["line"] and wait_log(r"^말함 \d+자$", app_log.index(done), 2))
    time.sleep(4)
    rs = trip(code)["requests"]; final = {r["id"]: r["status"] for r in rs}
    c = next((r for r in rs if r["id"] not in (reqs[0]["id"], reqs[1]["id"]) and r["createdAt"] > reqs[1]["createdAt"]), None)
    check("서버: A cancelled, B·C reflected", final.get(reqs[0]["id"]) == "cancelled" and final.get(reqs[1]["id"]) == "reflected" and c and c["status"] == "reflected",
          statuses=[(r["text"], r["status"]) for r in rs[-3:]])
    note("top", activity=cap.top()); shot("03-navi-with-waypoint")
    front_app(); shot("04-offer-added"); ui = texts(); note("ui", texts=ui)
    check("우리 화면으로 돌아오면 '경유지를 추가했어요'", "경유지를 추가했어요" in ui)
    subprocess.run(ADB + ["emu", "screenrecord", "stop"]); time.sleep(2)

    tap_switch(); time.sleep(1); gear("Park")
    (OUT / "app-log.json").write_text(json.dumps(app_log, ensure_ascii=False, indent=1))
    (OUT / "results.json").write_text(json.dumps({"code": code, "latency_s": lat, "p95_s": p95, "log": e2e.log}, ensure_ascii=False, indent=1))
    fails = [x["name"] for x in e2e.log if x["step"] == "check" and not x["ok"]]
    print("실패:", fails if fails else "없음")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main(sys.argv[1])
