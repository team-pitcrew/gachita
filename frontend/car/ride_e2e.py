"""동승 연결 E2E(T46 차 몫): 탑승자 폰이 띄운 1회용 QR을 주차 중인 차가 카메라로 읽고, 고른 자리에 그 사람을 넣는다.

준비: e2e.py와 같다(make run 또는 GACHITA_PORT의 서버, adb forward tcp:8088 tcp:8088, ./gradlew assembleDebug).
      에뮬레이터의 뒤 카메라를 가상 장면으로 켠다(-camera-back virtualscene). QR은 가상 장면의 벽 포스터로 넣는다
      (adb emu virtualscene-image wall <png>). 사람 손으로는 폰을 카메라에 비추는 것과 같다.
실행: python3 frontend/car/ride_e2e.py frontend/car/app/build/outputs/apk/debug/app-debug.apk <저장소 밖 폴더>

순서: 폰 역할(이 스크립트)이 프로필을 만들고 동승 QR을 받음(POST /api/ride-links) → QR을 PNG로 만들어 벽 포스터로
      → 차: 엄마를 빼고 여행 만들기 → '폰 QR 읽기' → 카메라가 QR을 읽음 → '조수석' → 일행에 '엄마 · 조수석 · 동의 대기'
      → 폰의 결과 조회(GET /api/ride-links/{id})가 linked → 같은 QR을 다시 읽혀 409 안내 → 기어 D에서 카드가 가려짐
- QR PNG는 앱이 쓰는 zxing core(Gradle 캐시의 jar)로 만든다. 결과는 OUT/results.json, 캡처는 OUT/*.png.
"""
import json, pathlib, subprocess, sys, tempfile, threading, time, urllib.request
import e2e, capture_e2e as cap
from e2e import ADB, PKG, OUT, adb, shot, texts, tap_text, gear, check, note

API = f"http://localhost:{cap.PORT}"
JAVA = "/opt/homebrew/opt/openjdk@21/bin/java"
GEN = """
import com.google.zxing.*; import com.google.zxing.common.BitMatrix; import com.google.zxing.qrcode.QRCodeWriter;
import java.awt.image.BufferedImage; import java.io.File; import java.util.Map; import javax.imageio.ImageIO;
public class QrPng { public static void main(String[] a) throws Exception {
  int n = 1024; BitMatrix m = new QRCodeWriter().encode(a[0], BarcodeFormat.QR_CODE, n, n, Map.of(EncodeHintType.MARGIN, 4));
  BufferedImage img = new BufferedImage(n, n, BufferedImage.TYPE_INT_RGB);
  for (int y = 0; y < n; y++) for (int x = 0; x < n; x++) img.setRGB(x, y, m.get(x, y) ? 0 : 0xFFFFFF);
  ImageIO.write(img, "png", new File(a[1])); } }
"""


def api(method, path, body=None, token=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(req, timeout=10) as r: return json.load(r)


def qr_png(text, out):
    jar = next(pathlib.Path.home().glob(".gradle/caches/modules-2/files-2.1/com.google.zxing/core/*/*/core-*.jar"))
    src = pathlib.Path(tempfile.mkdtemp()) / "QrPng.java"; src.write_text(GEN)
    subprocess.run([JAVA, "-cp", str(jar), str(src), text, str(out)], check=True)


def poster(png):
    """가상 장면 카메라의 벽 포스터를 바꾼다(에뮬레이터 콘솔)."""
    note("poster", out=subprocess.run(ADB + ["emu", "virtualscene-image", "wall", str(png.resolve())], capture_output=True, text=True).stdout.strip()[-80:])


def main(apk):
    threading.Thread(target=e2e.heartbeat, daemon=True).start()
    # 폰 역할: 프로필과 동승 QR
    phone = api("POST", "/api/profiles", {"name": "엄마"})["token"]
    link = api("POST", "/api/ride-links", {}, phone)
    note("phone.qr", id=link["id"], expiresAt=link["expiresAt"], has_participant_token=bool(link.get("participantToken")))
    png = OUT / "ride-qr.png"; qr_png(link["qr"], png); poster(png)

    note("install", out=subprocess.run(ADB + ["install", "--user", "10", "-r", "-g", apk], capture_output=True, text=True).stdout.strip()[-120:])
    gear("Park")
    adb("shell", "am", "force-stop", "--user", "10", PKG); adb("shell", "pm", "clear", "--user", "10", PKG)
    for perm in ("RECORD_AUDIO", "POST_NOTIFICATIONS", "CAMERA"): adb("shell", "pm", "grant", "--user", "10", PKG, f"android.permission.{perm}")
    adb("shell", "am", "start", "--user", "10", "-n", f"{PKG}/.MainActivity", "--es", "server", f"http://10.0.2.2:{cap.PORT}")
    time.sleep(4); tap_text("엄마 · 조수석"); time.sleep(1); tap_text("여행 만들기"); time.sleep(5)
    ui = texts(); code = next((t.split()[-1] for t in ui if t.startswith("여행 코드")), None); note("trip", code=code)
    check("엄마를 빼고 여행을 만듦(조수석이 빔)", code and not any(t.startswith("엄마 ·") for t in ui))

    tap_text("폰 QR 읽기")
    ui = cap.wait_texts(lambda u: "어느 자리에 앉았나요?" in u, 30); shot("1-scanned"); note("ui", texts=ui)
    check("주차 중 카메라가 폰의 동승 QR을 읽고 자리를 물음(빈자리만)", "어느 자리에 앉았나요?" in ui and "조수석" in ui and "운전석" not in ui)
    tap_text("조수석")
    ui = cap.wait_texts(lambda u: any(t.startswith("엄마 · 조수석") for t in u), 15); shot("2-seated"); note("ui", texts=ui)
    check("일행에 '엄마 · 조수석 · 동의 대기'(동의는 폰에서만)", "엄마 · 조수석 · 동의 대기" in ui or "엄마 · 조수석" in ui, texts=[t for t in ui if t.startswith("엄마")])
    trip = api("GET", f"/api/trips/{code}")
    mom = next((p for p in trip["participants"] if p["name"] == "엄마"), None)
    check("서버: 엄마가 조수석, 동의 꺼짐, 여행 응답에 토큰 없음", mom and mom["seat"] == "ROW_1_RIGHT" and not mom["consent"] and "token" not in json.dumps(trip))
    got = api("GET", f"/api/ride-links/{link['id']}", token=phone)
    check("폰의 결과 조회가 linked(그 여행)", got.get("status") == "linked" and got.get("tripCode") == code, status=got.get("status"))

    # 같은 QR을 다시 읽히면 이미 쓴 QR → 409 안내
    tap_text("폰 QR 읽기")
    ui = cap.wait_texts(lambda u: "어느 자리에 앉았나요?" in u, 30)
    if "어느 자리에 앉았나요?" in ui:
        tap_text(next(t for t in ("뒷자리 가운데", "뒷자리 왼쪽", "뒷자리 오른쪽") if t in ui))
        ui = cap.wait_texts(lambda u: any("이미 연결한 QR" in t for t in u), 10); shot("3-reused"); note("ui", texts=ui)
    check("이미 쓴 QR은 거절되고 안내", any("이미 연결한 QR" in t for t in ui))
    tap_text("취소")

    tap_text("폰 QR 읽기"); time.sleep(3)
    gear("Drive"); time.sleep(3); ui = texts(); shot("4-drive"); note("ui", texts=ui)
    cams = adb("shell", "dumpsys", "media.camera")
    check("기어 D: 동승자 연결 카드가 가려지고 카메라를 놓음", "동승자 연결" not in ui and "Device 1 is closed" in cams and "Device 0 is closed" in cams)
    gear("Park")

    (OUT / "results.json").write_text(json.dumps(e2e.log, ensure_ascii=False, indent=1))
    fails = [x for x in e2e.log if x["step"] == "check" and not x["ok"]]
    print(f"검사 {sum(1 for x in e2e.log if x['step'] == 'check')}개 중 실패 {len(fails)}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main(sys.argv[1])
