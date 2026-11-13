"""도착 브리핑 E2E(T40): 주행 중 가상 마이크에 넣은 장소별 할 일이 그 장소(내비 목적지)에서 P로 바꾸면 뜨고, 완료한 것은 다음 알림에서 빠지는지 본다.

준비: capture_e2e.py와 같다(make run, -grpc 8556 -grpc-use-token -audio none으로 Cold boot한 에뮬레이터, adb forward tcp:8088 tcp:8088,
      ./gradlew assembleDebug). 넣는 소리는 macOS say(Yuna) 합성 음성이다.
실행: python3 frontend/car/arrival_e2e.py frontend/car/app/build/outputs/apk/debug/app-debug.apk <저장소 밖 폴더>

순서: 앱이 내비 목적지를 강릉역으로(--es route) → 여행 만들기 → P에서 동의 켬 → 기어 D에서 '마트에서 …' 할 일 두 건
      → P: 다음 곳이 마트가 아니라 알리지 않음 → 목적지를 이마트 강릉점으로 → D → P: 두 건이 화면과 TTS로 → 하나 완료
      → D: 목록이 가려짐 → P: 한 건만 → Gleo가 보내는 것과 같은 인텐트로 함수를 부름.
- 도착은 차 위치가 아니라 'P로 바뀐 순간 내비가 향하는 다음 곳(첫 경유지, 없으면 목적지)의 이름에 장소 낱말이 있는가'로 본다.
  에뮬레이터에서 차를 옮기지 않는다.
- Gleo에 소리를 넣어 부르지 않는다. 우리 앱이 수음한 부팅에서 Gleo만 듣는 중에 소리를 넣으면 에뮬레이터가 멈춘 적이 있다(11/13).
- 결과는 OUT/results.json, 앱 로그(글자 없음)는 OUT/app-log.json, 주차 장면 녹화는 OUT/arrival.webm.
"""
import json, shlex, subprocess, sys, threading, time
import e2e, capture_e2e as cap, waypoint_e2e as wp
from e2e import ADB, PKG, OUT, adb, shot, texts, tap_text, tap_switch, gear, check, note
from waypoint_e2e import app_log, wait_log, front_app

MART = "37.7706258,128.9226191,이마트 강릉점"  # 카카오 장소 검색(11/13)
GANGNEUNG = wp.GANGNEUNG
TODOS = [("엄마", "마트에서 우유랑 간식 사자"), ("아빠", "마트에서 물도 사야 돼")]
GLEO = f"{PKG}.GACHITA_ARRIVAL_TASKS"


def brief_items(ui):
    """도착 브리핑 카드('마트에서 할 일' ~ '닫기')의 할 일 글. 차 안 할 일 파일은 암호화돼(T69) 기기 파일로 읽지 않는다."""
    if "마트에서 할 일" not in ui or "닫기" not in ui: return []
    a = ui.index("마트에서 할 일"); b = ui.index("닫기", a)
    return [t for t in ui[a + 1:b] if t != "완료"]


def main(apk):
    threading.Thread(target=e2e.heartbeat, daemon=True).start()
    threading.Thread(target=wp.logcat, daemon=True).start()
    inj = cap.Injector()
    for i, line in enumerate(TODOS): cap.fixture(f"todo{i}", [line], tail=4.0)
    note("apk", sha256=e2e.hashlib.sha256(open(apk, "rb").read()).hexdigest())
    adb("logcat", "-b", "all", "-c")
    note("install", out=subprocess.run(ADB + ["install", "--user", "10", "-r", "-g", apk], capture_output=True, text=True).stdout.strip()[-120:])
    time.sleep(5)
    loaded = [l for l in adb("logcat", "-d", "-b", "all").splitlines() if "schema" in l.lower() and PKG in l]
    note("gleo.schema", lines=[l[-160:] for l in loaded][:5])
    gear("Park")
    subprocess.run(["curl", "-s", "-X", "PUT", "http://127.0.0.1:8088/vehicle/controls?speed=0&accelerator=0&brake=0"], capture_output=True, timeout=5)  # 앞 시험의 속도가 남으면 P여도 제한이 풀리지 않는다
    adb("shell", "am", "force-stop", "--user", "10", PKG); adb("shell", "pm", "clear", "--user", "10", PKG)
    for perm in ("RECORD_AUDIO", "POST_NOTIFICATIONS"): adb("shell", "pm", "grant", "--user", "10", PKG, f"android.permission.{perm}")
    n0 = len(app_log)
    adb("shell", "am", "start", "--user", "10", "-n", f"{PKG}/.MainActivity", "--es", "server", f"http://10.0.2.2:{cap.PORT}", "--es", "route", shlex.quote(GANGNEUNG))
    check("앱이 내비 목적지를 강릉역으로(onRouteStarted)", wait_log("경로 시작 강릉역", n0, 30))
    time.sleep(2); front_app(); tap_text("여행 만들기"); time.sleep(4)
    ui = texts(); code = next((t.split()[-1] for t in ui if t.startswith("여행 코드")), None); note("trip", code=code)
    tap_switch()
    ui = cap.wait_texts(lambda u: "● 기록 중" in u, 10)
    if not check("P에서 동의를 켜면 기록 중", "● 기록 중" in ui and cap.mic_holders()):
        raise SystemExit("수음이 열리지 않아 소리를 넣지 않고 멈춥니다")

    # 1. 주행 중 할 일 두 건: 모이지만 목록은 띄우지 않는다
    gear("Drive")
    for i in range(len(TODOS)):
        k = len(app_log); inj.play(f"todo{i}")
        check(f"할 일 {i + 1} 보관(마트)", wait_log(r"할 일 보관 마트", k, 15))
    ui = texts(); shot("01-drive-two-todos"); note("ui", texts=ui)
    check("기어 D: 도착해서 할 일 2건", "도착해서 할 일 2건" in ui)
    # 2. 다음 곳이 마트가 아닌 데서 P: 알리지 않는다
    k = len(app_log); gear("Park")
    a = wait_log(r"^주차 · 다음 곳", k, 8); time.sleep(1); ui = texts(); note("park.elsewhere", line=a and a["line"])
    check("다음 곳이 강릉역일 때 P: 도착 브리핑 없음", a and "도착 false" in a["line"] and "마트에서 할 일" not in ui and not wait_log(r"^도착 브리핑", k, 0.1))
    k = len(app_log); adb("shell", "am", "start", "--user", "10", "-n", f"{PKG}/.MainActivity", "--es", "route", shlex.quote(MART))
    check("목적지를 이마트 강릉점으로 바꿈(onRouteStarted)", wait_log("경로 시작 이마트 강릉점", k, 30))
    time.sleep(2); front_app(); gear("Drive"); time.sleep(1)

    # 3. P: 다음 곳(목적지)이 마트 → 두 건을 화면과 말로
    subprocess.run(ADB + ["emu", "screenrecord", "start", str((OUT / "arrival.webm").resolve())])
    k = len(app_log); gear("Park")
    b = wait_log(r"도착 브리핑 마트 \d건", k, 10); note("brief", line=b and b["line"], navi=[e["line"] for e in app_log[k:] if e["line"].startswith("주차")])
    time.sleep(2); ui = texts(); shot("02-park-brief-two"); note("ui", texts=ui)
    items = brief_items(ui); note("todos", items=items)
    check("P: 마트 할 일 두 건이 화면에", b and "2건" in b["line"] and len(items) == 2)
    check("P: 두 건을 말(TTS)로", b and wait_log(r"^말함 \d+자$", app_log.index(b), 3))
    # 4. 하나 완료 → D에서는 목록이 가려짐 → P에서 남은 하나만
    k = len(app_log); tap_text("완료", last=False)
    check("하나 완료", wait_log(r"할 일 완료 · 남은 1건", k, 5))
    gear("Drive"); time.sleep(2); ui = texts(); shot("03a-drive-hidden"); note("ui", texts=ui)
    check("기어 D: 브리핑이 열려 있어도 목록은 가려지고 할 일 수만", "마트에서 할 일" not in ui and "도착해서 할 일 1건" in ui)
    k = len(app_log); gear("Park")
    b = wait_log(r"도착 브리핑 마트 \d건", k, 10)
    time.sleep(2); ui = texts(); shot("03b-park-brief-one"); note("ui", texts=ui)
    check("다음 알림에는 완료한 것이 빠지고 한 건만", b and "1건" in b["line"] and brief_items(ui) == items[1:])
    subprocess.run(ADB + ["emu", "screenrecord", "stop"]); time.sleep(2)

    # 5. Gleo 함수: Gleo가 보내는 것과 같은 action으로 화면을 연다(Gleo에 소리는 넣지 않음)
    tap_text("닫기"); time.sleep(1)
    k = len(app_log); adb("shell", "am", "start", "--user", "10", "-a", GLEO)
    g = wait_log(r"^Gleo 도착 할 일 \d+건$", k, 8)
    r = wait_log(r"^Gleo 응답 GACHITA_ARRIVAL_TASKS success$", k, 8)  # 응답의 functionName은 schema의 함수 이름 그대로(T41부터 응답 줄이 따로)
    time.sleep(1); ui = texts(); shot("04-gleo-action"); note("ui", texts=ui)
    check("Gleo 함수: 남은 할 일 1건을 띄우고 성공으로 응답", g and g["line"] == "Gleo 도착 할 일 1건" and r and "도착해서 할 일" in ui and f"마트 · {items[1]}" in ui)

    tap_switch(); time.sleep(1)
    (OUT / "app-log.json").write_text(json.dumps(app_log, ensure_ascii=False, indent=1))
    (OUT / "results.json").write_text(json.dumps({"code": code, "todos": items, "log": e2e.log}, ensure_ascii=False, indent=1))
    fails = [x["name"] for x in e2e.log if x["step"] == "check" and not x["ok"]]
    print("실패:", fails if fails else "없음")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main(sys.argv[1])
