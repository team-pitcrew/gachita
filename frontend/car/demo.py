"""시연 영상 장면 녹화(T13): 강릉 가족 여행 흐름을 에뮬레이터에서 장면별로 돌려 화면을 녹화하고, 넣은 대사를 소리에 섞어 장면 파일을 만든다.

준비: capture_e2e.py와 같다(make run, -grpc 8556 -grpc-use-token -audio none으로 Cold boot한 에뮬레이터, adb forward tcp:8088 tcp:8088,
      ./gradlew assembleDebug). ffmpeg가 있어야 한다.
실행: python3 frontend/car/demo.py <APK> <저장소 밖 폴더>

장면(docs/demo-video.md): 1 기록 동의(주차) → 2 주행 중 기록(기어 D, 대화와 장소가 붙은 할 일) → 3 부탁이 경유지로 → 4 마트에 주차해 도착 브리핑.
- 여행 목적지는 이마트 강릉점. 3에서 휴게소가 경유지로 들어가므로, 4 앞에서 목적지를 다시 넣어 '휴게소를 지나 마트로 가는 중'을 만든다
  (앱은 내비가 향하는 다음 곳이 할 일의 장소일 때 도착으로 본다).
- 에뮬레이터 녹화(adb emu screenrecord)에는 스피커 소리(TTS)만 들어가고 가상 마이크에 넣은 소리는 들어가지 않는다.
  넣은 대사(합성 음성 WAV)를 넣은 시각에 맞춰 섞는다. 맞춤은 Mac 시계 기준이라 0.1~0.3초 어긋날 수 있다.
- 대사는 macOS say(Yuna) 합성 음성이다. 영상에는 팀원이 녹음한 대사로 바꾸는 편이 낫다(docs/demo-video.md).
- 마트 도착은 차를 옮기지 않고 기어 P로 연출한다. 앱은 '내비 목적지가 할 일의 장소인가'로 도착을 본다.
- 결과: OUT/scene-N.webm(원본), OUT/scene-N.mp4(대사를 섞고 '에뮬레이터 실행 화면'을 적은 것), OUT/draft.mp4(이어 붙인 가편집),
  OUT/short.mp4(숏폼용 세로 1080×1920: 위는 Driving view의 속도·기어, 아래는 우리 앱 왼쪽 칸. 장면 2~4), OUT/clips.json.
- 녹화는 두고 섞기만 다시: python3 frontend/car/demo.py --remix <폴더>
"""
import json, shlex, subprocess, sys, threading, time
import e2e, capture_e2e as cap, waypoint_e2e as wp
from e2e import ADB, PKG, OUT, adb, tap_text, tap_switch, gear, check, note
from waypoint_e2e import app_log, wait_log, front_app

MART = "37.7706258,128.9226191,이마트 강릉점"  # 카카오 장소 검색(11/13). 이 여행의 내비 목적지
LINES = {  # 왼쪽 채널 = 앞줄(아빠·엄마), 오른쪽 = 뒷줄(아들·딸)
    "talk": [("딸", "아빠, 바다는 언제 보여?"), ("아빠", "산을 몇 개 넘어야 바다가 나와.")],
    "todo": [("엄마", "마트에서 우유랑 간식 사자"), ("아빠", "마트에서 물도 사야 돼")],
    "ask": [("아들", "화장실 가고 싶어")],
    "yes": [("아빠", "응, 다음 휴게소 가자")],
}
LABEL = "에뮬레이터 실행 화면 · 합성 음성"
FONT = "/System/Library/Fonts/AppleSDGothicNeo.ttc"
clips = []


class Scene:
    """장면 하나의 녹화. 시작 시각(Mac)을 잡아 두었다 대사를 섞을 때 쓴다."""
    def __init__(self, n, title):
        self.n, self.title = n, title

    def __enter__(self):
        self.file = OUT / f"scene-{self.n}.webm"
        subprocess.run(ADB + ["emu", "screenrecord", "start", str(self.file.resolve())])
        self.t0 = time.time() * 1000
        note("scene.start", n=self.n, title=self.title)
        return self

    def __exit__(self, *exc):
        time.sleep(1); subprocess.run(ADB + ["emu", "screenrecord", "stop"]); time.sleep(2)
        note("scene.stop", n=self.n, seconds=round((time.time() * 1000 - self.t0) / 1000, 1))

    def say(self, inj, name):
        at = inj.play(name)
        clips.append({"scene": self.n, "clip": name, "offset_ms": round(at - self.t0)})


def speed(kmh):
    """Virtual Console 속도. 주행 제한은 P여도 5 km/h를 넘으면 풀리지 않으므로 주차 전에 0으로."""
    subprocess.run(["curl", "-s", "-X", "PUT", f"http://127.0.0.1:8088/vehicle/controls?speed={kmh}&accelerator={20 if kmh else 0}&brake=0"], capture_output=True, timeout=5)
    note("speed", kmh=kmh)


def mix(n):
    """장면 녹화에 넣은 대사를 섞고(TTS는 작게 녹음돼 키움) 오른쪽 위에 표시를 적는다."""
    src = OUT / f"scene-{n}.webm"; mine = [c for c in clips if c["scene"] == n]
    args = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src)] + sum((["-i", str(OUT / "inputs" / f"{c['clip']}.wav")] for c in mine), [])
    parts = ["[0:a]volume=3[a0]"] + [f"[{i + 1}:a]adelay={max(0, c['offset_ms'])}:all=1[a{i + 1}]" for i, c in enumerate(mine)]
    parts.append("".join(f"[a{i}]" for i in range(len(mine) + 1)) + f"amix=inputs={len(mine) + 1}:normalize=0:duration=first,alimiter=limit=0.9[a]")  # 잘리지 않게
    parts.append(f"[0:v]drawtext=fontfile={FONT}:text='{LABEL}':fontsize=30:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=10:x=w-tw-40:y=1240[v]")
    subprocess.run(args + ["-filter_complex", ";".join(parts), "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "24",
                           "-c:a", "aac", "-b:a", "160k", str(OUT / f"scene-{n}.mp4")], check=True)


def main(apk):
    threading.Thread(target=e2e.heartbeat, daemon=True).start()
    threading.Thread(target=wp.logcat, daemon=True).start()
    inj = cap.Injector()
    for name, lines in LINES.items(): cap.fixture(name, lines, lead=0.5, tail=2.5)
    note("apk", sha256=e2e.hashlib.sha256(open(apk, "rb").read()).hexdigest())
    subprocess.run(ADB + ["install", "--user", "10", "-r", "-g", apk], capture_output=True)
    gear("Park")
    adb("shell", "am", "force-stop", "--user", "10", PKG); adb("shell", "pm", "clear", "--user", "10", PKG)
    for perm in ("RECORD_AUDIO", "POST_NOTIFICATIONS"): adb("shell", "pm", "grant", "--user", "10", PKG, f"android.permission.{perm}")
    k = len(app_log)
    adb("shell", "am", "start", "--user", "10", "-n", f"{PKG}/.MainActivity", "--es", "server", f"http://10.0.2.2:{cap.PORT}", "--es", "route", shlex.quote(MART))
    check("내비 목적지 이마트 강릉점", wait_log("경로 시작 이마트 강릉점", k, 30))
    time.sleep(2); front_app(); time.sleep(1)

    with Scene(1, "기록 동의"):
        time.sleep(2); tap_text("여행 만들기"); time.sleep(5)
        tap_switch()
        check("기록 중", "● 기록 중" in cap.wait_texts(lambda u: "● 기록 중" in u, 10) and cap.mic_holders())
        time.sleep(4)
    with Scene(2, "주행 중 기록") as sc:
        gear("Drive"); speed(80); time.sleep(2)
        sc.say(inj, "talk"); time.sleep(1)
        k = len(app_log); sc.say(inj, "todo")
        check("할 일 두 건", wait_log(r"이 여행 2건", k, 10))
        time.sleep(3)
    with Scene(3, "부탁이 경유지로") as sc:
        k = len(app_log); sc.say(inj, "ask")
        check("제안", wait_log(r"^제안 ", k, 10)); time.sleep(3)
        k = len(app_log); sc.say(inj, "yes")
        check("경유지 반영", wait_log(r"^경유지 반영", k, 40)); time.sleep(4)
        front_app(); time.sleep(4)
    k = len(app_log); adb("shell", "am", "start", "--user", "10", "-n", f"{PKG}/.MainActivity", "--es", "route", shlex.quote(MART))
    check("휴게소를 지나 마트로(경로 다시)", wait_log("경로 시작 이마트 강릉점", k, 30)); time.sleep(2); front_app(); time.sleep(1)
    with Scene(4, "마트 도착") as sc:
        speed(0); k = len(app_log); gear("Park")
        check("도착 브리핑", wait_log(r"도착 브리핑 마트 2건", k, 10)); time.sleep(9)
        k = len(app_log); check("완료 누름", tap_text("완료", last=False) and wait_log(r"할 일 완료", k, 5)); time.sleep(3)
    tap_switch(); time.sleep(1)

    (OUT / "clips.json").write_text(json.dumps(clips, ensure_ascii=False, indent=1))
    cut()
    (OUT / "results.json").write_text(json.dumps({"clips": clips, "log": e2e.log}, ensure_ascii=False, indent=1))
    (OUT / "app-log.json").write_text(json.dumps(app_log, ensure_ascii=False, indent=1))
    fails = [x["name"] for x in e2e.log if x["step"] == "check" and not x["ok"]]
    print("실패:", fails if fails else "없음")
    sys.exit(1 if fails else 0)


def vertical(n):
    """숏폼용 세로 자르기: 위에 Driving view의 속도·기어(853×300), 아래에 우리 앱 창의 왼쪽 칸(847×1210)."""
    v = (f"[0:v]split[a][b];[a]crop=853:300:0:0,scale=1080:380[top];[b]crop=847:1210:853:90,scale=1080:1540[bot];[top][bot]vstack,"
         f"drawtext=fontfile={FONT}:text='{LABEL}':fontsize=34:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=10:x=(w-tw)/2:y=h-70[v]")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(OUT / f"scene-{n}.mp4"), "-filter_complex", v, "-map", "[v]", "-map", "0:a",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "24", "-c:a", "aac", "-b:a", "160k", str(OUT / f"short-{n}.mp4")], check=True)


def join(names, out):
    (OUT / f"{out}.txt").write_text("".join(f"file '{n}.mp4'\n" for n in names))
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(OUT / f"{out}.txt"), "-c", "copy", str(OUT / f"{out}.mp4")], check=True)


def cut():
    for n in range(1, 5): mix(n)
    join([f"scene-{n}" for n in range(1, 5)], "draft")
    for n in range(2, 5): vertical(n)
    join([f"short-{n}" for n in range(2, 5)], "short")


def remix():
    """녹화는 두고 섞기만 다시(OUT/clips.json). 실행: python3 demo.py --remix <폴더>"""
    clips.extend(json.loads((OUT / "clips.json").read_text()))
    cut()


if __name__ == "__main__":
    remix() if sys.argv[1] == "--remix" else main(sys.argv[1])
