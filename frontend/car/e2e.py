"""로컬 E2E: 차량 앱에서 여행을 만들고 동의를 켜고 끄며, 서버에 생긴 것을 함께 기록한다.

준비: 저장소 루트에서 make run, Cold boot한 Pleos 에뮬레이터, adb forward tcp:8088 tcp:8088(Virtual Console),
      frontend/car에서 ./gradlew assembleDebug
실행: python3 frontend/car/e2e.py frontend/car/app/build/outputs/apk/debug/app-debug.apk <캡처를 둘 폴더>
- 에뮬레이터를 켜거나 끄지 않는다. 다른 앱은 건드리지 않는다. 기어는 끝나면 P로 둔다.
- 캡처와 results.json은 저장소 밖 폴더에 둔다.
"""
import hashlib, json, pathlib, re, subprocess, sys, time, urllib.request

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


def main(apk):
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
    check("기록 꺼짐 화면", "기록 꺼짐" in ui and "기어 P · " in " ".join(ui), )
    gear("Drive"); tap_switch(); time.sleep(2)
    shot("03-drive-cannot-turn-on"); ui = texts(); note("ui", texts=ui); t = server(code)
    check("기어 D에서는 켜지지 않음", "주차(P)한 뒤에 켤 수 있어요" in ui and "● 기록 중" not in ui and not any(p["consent"] for p in t["participants"]))
    gear("Park"); tap_switch(); time.sleep(3)
    shot("04-recording"); ui = texts(); note("ui", texts=ui); t = server(code)
    check("기어 P에서 켜면 기록 중, 서버 동의 모두 켜짐", "● 기록 중" in ui and all(p["consent"] for p in t["participants"]))
    gear("Drive")
    shot("05-recording-in-drive"); ui = texts(); note("ui", texts=ui)
    check("주행 중에도 기록 유지", "● 기록 중" in ui)
    tap_switch(); time.sleep(0.5)
    shot("06-turned-off"); ui = texts(); note("ui", texts=ui)
    check("끄면 바로 멈춤", "기록 꺼짐" in ui)
    time.sleep(3); t = server(code)
    check("서버 동의도 꺼짐", not any(p["consent"] for p in t["participants"]))
    gear("Park")
    # 반쪽 창(약 841): 에뮬레이터가 창을 나누지 않아 앱 안에서 폭을 줄여 그린다
    adb("shell", "am", "start", "--user", "10", "-S", "-n", f"{PKG}/.MainActivity", "--ei", "widthDp", "841")
    time.sleep(4); shot("07-half-width-841"); ui = texts(); note("ui", texts=ui)
    check("반쪽 폭에서도 기록 상태·일행·부탁·동의가 보임", all(any(x in u for u in ui) for x in ("기록 꺼짐", "일행 4명", "보관한 부탁", "대화 기록 동의")))
    (OUT / "results.json").write_text(json.dumps({"code": code, "log": log}, ensure_ascii=False, indent=1))
    fails = [e["name"] for e in log if e["step"] == "check" and not e["ok"]]
    print("실패:", fails if fails else "없음")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main(sys.argv[1])
