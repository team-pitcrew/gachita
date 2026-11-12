"""로컬 E2E: 차량 앱에서 여행을 만들고 동의를 켜고 끄며, 서버에 생긴 것을 함께 기록한다.

준비: 저장소 루트에서 make run, Cold boot한 Pleos 에뮬레이터, adb forward tcp:8088 tcp:8088(Virtual Console),
      frontend/car에서 ./gradlew assembleDebug
실행: python3 frontend/car/e2e.py frontend/car/app/build/outputs/apk/debug/app-debug.apk <캡처를 둘 폴더>
- 에뮬레이터를 켜거나 끄지 않는다. 다른 앱은 건드리지 않는다. 기어는 끝나면 P로 둔다.
- 캡처와 results.json은 저장소 밖 폴더에 둔다.
"""
import hashlib, json, pathlib, re, subprocess, sys, threading, time, urllib.request

ADB = [str(pathlib.Path.home() / "Library/Android/sdk/platform-tools/adb"), "-s", "emulator-5554"]
PKG = "io.github.teampitcrew.gachita"
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else ".")
log = []


def note(step, **kw):
    kw = {"t": time.strftime("%H:%M:%S"), "step": step, **kw}
    log.append(kw); print(json.dumps(kw, ensure_ascii=False))


def adb(*a):
    return subprocess.run(ADB + list(a), capture_output=True, text=True).stdout


def shot(name):
    with open(OUT / f"{name}.png", "wb") as f:
        subprocess.run(ADB + ["exec-out", "screencap", "-p"], stdout=f)
    note("shot", file=f"{name}.png")


def nodes():
    adb("shell", "uiautomator", "dump", "/data/local/tmp/t7-ui.xml")
    xml = adb("exec-out", "cat", "/data/local/tmp/t7-ui.xml")
    return re.findall(r'text="([^"]*)"[^>]*?checked="(\w+)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml), xml


def texts():
    return [n[0] for n in nodes()[0] if n[0]]


def tap_text(text, last=True):
    found = [n for n in nodes()[0] if n[0] == text]
    if not found:
        note("tap.miss", text=text); return False
    _, _, x1, y1, x2, y2 = found[-1 if last else 0]
    adb("shell", "input", "tap", str((int(x1) + int(x2)) // 2), str((int(y1) + int(y2)) // 2))
    note("tap", text=text); return True


def tap_switch():
    # Compose Switch는 글자 없이 checkable 노드로 나온다
    m = re.search(r'checkable="true"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', nodes()[1])
    x1, y1, x2, y2 = map(int, m.groups())
    adb("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))
    note("tap", text="switch")


def heartbeat():
    """Virtual Console은 브라우저 세션이 1초마다 살아 있다고 알려야 차량 값을 바꾼다."""
    while True:
        try: urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8088/browser/session?client=gachita-car-e2e", method="POST"), timeout=2).read()
        except Exception: pass
        time.sleep(1)


def gear(v):
    """Virtual Console로 기어를 바꾼다(Park, Drive). 콘솔 세션이 꺼져 있으면 200이어도 안 바뀌므로 앱 화면의 기어 글자로 확인한다."""
    with urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:8088/vehicle/gear?gear={v}", method="PUT"), timeout=10) as r:
        note("gear", to=v, vc=r.status)
    time.sleep(2)


def server(code):
    t = json.load(urllib.request.urlopen(f"http://localhost:8787/api/trips/{code}", timeout=5))
    note("server", code=code, status=t["status"], recording=t["recording"], consent=[(p["name"], p["consent"]) for p in t["participants"]], version=t["version"])
    return t


def check(name, ok, **kw):
    note("check", name=name, ok=bool(ok), **kw)
    return ok


ROOT = pathlib.Path(__file__).resolve().parents[2]


def server_up():
    try: return json.load(urllib.request.urlopen("http://localhost:8787/healthz", timeout=2)).get("ok")
    except Exception: return False


def stop_server():
    pids = subprocess.run(["lsof", "-t", "-iTCP:8787", "-sTCP:LISTEN"], capture_output=True, text=True).stdout.split()
    for pid in pids: subprocess.run(["kill", pid])
    time.sleep(1); note("server.stop", pids=pids, up=server_up())


def start_server():
    subprocess.Popen(["make", "run"], cwd=ROOT, stdout=open(OUT / "server-restart.log", "w"), stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(60):
        if server_up(): break
        time.sleep(1)
    note("server.start", up=server_up())


def main(apk):
    threading.Thread(target=heartbeat, daemon=True).start(); time.sleep(2)
    note("apk", sha256=hashlib.sha256(open(apk, "rb").read()).hexdigest(), size=pathlib.Path(apk).stat().st_size)
    note("install", out=subprocess.run(ADB + ["install", "--user", "10", "-r", "-g", apk], capture_output=True, text=True).stdout.strip()[-200:])
    gear("Park")
    adb("shell", "am", "force-stop", "--user", "10", PKG)
    adb("shell", "pm", "clear", "--user", "10", PKG)  # 지난 여행 없이 시작
    adb("shell", "am", "start", "--user", "10", "-n", f"{PKG}/.MainActivity", "--es", "server", "http://10.0.2.2:8787")
    time.sleep(4); shot("01-setup"); ui = texts(); note("ui", texts=ui)
    check("첫 화면", "여행 만들기" in ui)
    tap_text("여행 만들기"); time.sleep(4)
    ui = texts(); code = next((t.split()[-1] for t in ui if t.startswith("여행 코드")), None)
    shot("02-trip-consent-off"); note("ui", texts=ui)
    t = server(code)
    check("서버에 여행과 가족 4명, 동의는 모두 꺼짐", len(t["participants"]) == 4 and not any(p["consent"] for p in t["participants"]))
    check("기록 꺼짐 화면과 기어 P", "기록 꺼짐" in ui and any(u.startswith("기어 P") for u in ui))
    # 기어 D: 주행 중 화면 선언(T11) 전이라 Pleos 차단 화면이 앱을 덮는다. 누른 것이 앱에 닿지 않아야 한다
    gear("Drive"); tap_switch(); time.sleep(2)
    shot("03-drive-blocked"); ui = texts(); note("ui", texts=ui); t = server(code)
    check("기어 D에서는 켜지지 않음(서버 동의 그대로 꺼짐)", "● 기록 중" not in ui and not any(p["consent"] for p in t["participants"]))
    gear("Park"); tap_switch(); time.sleep(3)
    shot("04-recording"); ui = texts(); note("ui", texts=ui); t = server(code)
    check("기어 P에서 켜면 기록 중, 서버 동의 모두 켜짐", "● 기록 중" in ui and all(p["consent"] for p in t["participants"]))
    gear("Drive")
    shot("05-recording-drive-blocked"); ui = texts(); note("ui", texts=ui)
    check("기어 D 동안 앱 상태는 기록 중 유지(화면은 차단)", "● 기록 중" in ui)
    gear("Park")
    shot("06-back-to-park"); ui = texts(); note("ui", texts=ui)
    check("P로 돌아오면 기록 중 화면", "● 기록 중" in ui)
    # 통신 끊김: 서버를 내리고 다음 조회(10초)를 기다린다
    stop_server(); time.sleep(12)
    shot("07-offline-last-state"); ui = texts(); note("ui", texts=ui)
    check("끊겨도 마지막 여행과 기록 중을 보여 줌", "연결이 끊겼어요 · 마지막으로 확인한 정보예요" in ui and "● 기록 중" in ui and "일행 4명" in ui)
    tap_switch(); time.sleep(0.5)
    shot("08-off-while-offline"); ui = texts(); note("ui", texts=ui)
    check("끊긴 채로 끄면 바로 멈춤", "기록 꺼짐" in ui and "● 기록 중" not in ui)
    start_server(); time.sleep(12)
    t = server(code)
    check("서버가 돌아오면 끄기가 서버에 반영됨", not any(p["consent"] for p in t["participants"]))
    shot("09-synced"); ui = texts(); note("ui", texts=ui)
    check("다시 연결됨", "서버에 연결됐어요" in ui and "기록 꺼짐" in ui)
    # 반쪽 창(약 841): 에뮬레이터가 창을 나누지 않아 앱 안에서 폭을 줄여 그린다
    adb("shell", "am", "start", "--user", "10", "-S", "-n", f"{PKG}/.MainActivity", "--ei", "widthDp", "841")
    time.sleep(4); shot("10-half-width-841"); ui = texts(); note("ui", texts=ui)
    check("반쪽 폭에서도 기록 상태·일행·부탁·동의가 보임", all(any(x in u for u in ui) for x in ("기록 꺼짐", "일행 4명", "보관한 부탁", "대화 기록 동의")))
    (OUT / "results.json").write_text(json.dumps({"code": code, "log": log}, ensure_ascii=False, indent=1))
    fails = [e["name"] for e in log if e["step"] == "check" and not e["ok"]]
    print("실패:", fails if fails else "없음")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main(sys.argv[1])
