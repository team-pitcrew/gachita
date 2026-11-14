"""시연 플로우 35단계(T150): Figma `GISs0yf3c1KCjXwuFmF4ij` 프레임 `2045:1782` '전체 화면 → 좁은 주행 창 → 전체 화면'을
차 에뮬레이터 + 폰 역할(API) + 로컬 서버로 순서대로 띄우고, 단계마다 화면 글로 떴는지 보고 캡처한다.

준비(README '시연 실행'):
  - 고정 로컬 서버 http://localhost:8800(local-stack.sh, 에뮬레이터는 http://10.0.2.2:8800). 다른 서버는 GACHITA_PORT.
  - Pleos 에뮬레이터를 -grpc <포트> -grpc-use-token -audio none으로 Cold boot(소리 넣기). 고르는 것은 -s <serial>(또는 ANDROID_SERIAL,
    기본 emulator-5562). gRPC 포트는 그 에뮬레이터의 실행 기록에서 읽고(GACHITA_GRPC_PORT로 바꿈, 없으면 대사를 넣지 않음),
    Virtual Console(기기 안 8088)은 빈 포트로 adb forward해 둔다(GACHITA_VC_URL로 바꿈).
  - 디버그 APK(./gradlew assembleDebug). ffmpeg는 녹화(DEMO_RECORD=1)할 때만.
실행:
  python3 frontend/car/demo.py --plan <저장소 밖 폴더>     단계표와 각 PR의 지금 상태만(기기 없음)
  python3 frontend/car/demo.py --seed <폴더>              시연 가족(계정·동의·목소리·그룹·좌석)만 실제 API로
  python3 frontend/car/demo.py [-s <serial>] <APK 또는 -> <폴더>   35단계를 돌린다(-는 깔지 않고 지금 앱으로)
  DEMO_STEPS=17-26 처럼 범위를 주면 그 단계만(앞 단계가 만드는 것은 API로 채움). DEMO_PHONE=manual이면 엄마 참여를 폰에서 손으로
  하도록 초대 링크를 알리고 기다린다(기본 api: 폰 웹앱이 보내는 것과 같은 요청을 스크립트가 보냄).

지키는 것:
- 기본은 시드 시나리오(오너 지시 11/15 "시연 동안은 화자 분리나 전체 시나리오를 목업 데이터로"): 서버에 실제 API로 받아 적은 말(말한 사람·
  speakerMethod device-voice)·장소·도착 브리핑·장면·영상을 넣고, 차 화면 17–24는 차의 디버그 목업(--es f4 drive…final)으로 띄운다.
  시드·목업으로 띄운 단계는 steps.md에 '시드'로 적는다. 실제 소리 넣기와 내비 판정은 DEMO_VOICE=1일 때만.
- 단계의 화면 글이 안 보이면 그 단계를 '없음'으로 적고(그 흐름의 PR 번호·상태와 함께) 다음으로 간다.
- 하지 않는 것: 동의 없는 녹음, 토큰 없이 개인정보 보내기, 원음 전체 업로드(장면 소리는 합성 음성 조각만 올림).
- 시드는 실제 API만(DB에 직접 쓰지 않음). 같은 폴더로 다시 돌리면 같은 계정·그룹을 다시 쓴다(OUT/demo-state.json, 저장소에 넣지 않음).
- 대사는 macOS say(Yuna) 합성 음성이다(cap.say, 사람마다 음높이만 다름). 목소리 등록도 같은 합성 음성이라 차 안 화자 식별이 맞는다.
  실제 녹음을 쓰려면 OUT/inputs/에 talk·mart·lodge·enroll-아빠·enroll-엄마·enroll-서준·enroll-하은.wav(16 kHz 2채널, 왼쪽 = 앞줄)를
  같은 이름의 .json 없이 미리 둔다. 그러면 합성하지 않고 그 녹음을 넣고, 목소리 값(API)도 그 enroll 녹음으로 만든다.
- 에뮬레이터 내비의 지금 위치는 판교에 고정이다(waypoint_e2e.py 머리 주석). 도착 장면은 그 근처 좌표에 시안의 장소 이름
  ('하나로마트', '강릉 숙소')을 붙인 시연 경로로 만들고(--es route/stops, 디버그 빌드), 남은 시간·도착 판정은 앱과 서버가 실제로 한다.
- 창 크기는 앱이 못 바꾼다(T112). 16→17과 24→25는 운전자의 창 바(⋮) 손짓을 adb로 흉내 낸다. 앱을 다시 열면(경로 바꾸기)
  가치타가 왼쪽 넓은 창으로 옮겨 가므로 곧바로 다시 나눈다 — 녹화에서는 그 몇 초를 자른다.
- 시작할 때 시스템 밤 모드를 켠다(시안의 차 화면은 모두 어둡다). 앱 데이터는 지우지 않는다(오너 지시). 01부터 새로 보려면 DEMO_CLEAN=1.
- 끝나면(중간에 멈춰도) 속도 0·기어 P, 앱은 이 서버(--es server)를 가리킨 채로 둔다.
- 결과: OUT/steps.json·steps.md(단계표와 결과), OUT/NN-이름.png, OUT/inputs/*.wav(넣은 소리), DEMO_RECORD=1이면 OUT/part-N.webm·mp4.
"""
import json, os, pathlib, re, shlex, subprocess, sys, threading, time, urllib.error, urllib.request, wave

os.environ.setdefault("GACHITA_PORT", "8800")  # 고정 로컬 서버(local-stack.sh). 임시 서버는 서버 변경을 시험할 때만
if "-s" in sys.argv[1:-1]:  # demo.py -s emulator-5558 <APK> <폴더>: 돌릴 에뮬레이터(ANDROID_SERIAL과 같음)
    i = sys.argv.index("-s"); os.environ["ANDROID_SERIAL"] = sys.argv[i + 1]; del sys.argv[i:i + 2]
os.environ.setdefault("ANDROID_SERIAL", "emulator-5562")
_ADB = [str(pathlib.Path.home() / "Library/Android/sdk/platform-tools/adb"), "-s", os.environ["ANDROID_SERIAL"]]
if "GACHITA_GRPC_PORT" not in os.environ:  # 소리 넣기: 그 에뮬레이터를 켤 때 준 -grpc 포트(실행 기록 pid_*.ini). 없으면 넣지 않는다
    for _ini in (pathlib.Path.home() / "Library/Caches/TemporaryItems/avd/running").glob("pid_*.ini"):
        _kv = dict(l.split("=", 1) for l in _ini.read_text().splitlines() if "=" in l)
        if "emulator-" + _kv.get("port.serial", "") == os.environ["ANDROID_SERIAL"] and _kv.get("grpc.port"): os.environ["GACHITA_GRPC_PORT"] = _kv["grpc.port"]
    os.environ.setdefault("GACHITA_GRPC_PORT", "0")
if "GACHITA_VC_URL" not in os.environ and sys.argv[1:2] not in (["--plan"], ["--seed"], ["--check"]):  # Virtual Console(기기 안 8088)을 빈 포트로 이어 둔다
    _port = subprocess.run(_ADB + ["forward", "tcp:0", "tcp:8088"], capture_output=True, text=True).stdout.strip()
    if _port.isdigit(): os.environ["GACHITA_VC_URL"] = f"http://127.0.0.1:{_port}"
import e2e, capture_e2e as cap  # noqa: E402  같은 폴더의 E2E 도구(adb, 화면 트리, 기어, 소리 넣기)
from e2e import ADB, PKG, OUT, adb, gear, check, note  # noqa: E402

PORT = int(os.environ["GACHITA_PORT"])
API = f"http://localhost:{PORT}/api"
CAR_SERVER = f"http://10.0.2.2:{PORT}"
NAV = "ai.umos.maps.android.navigation.app"
REPO = "team-pitcrew/gachita"
STATE = OUT / "demo-state.json"

# 사람: 부르는 이름 → (cap의 목소리 키, 캐릭터, 좌석, 프로필 이름). cap.PITCH·ROW는 아빠·엄마·아들·딸(음높이와 앞줄/뒷줄 채널).
# 아빠의 프로필 이름은 시안 04·07처럼 '민준'이다(그룹 여행의 참가자 이름도 프로필 이름이라 주행 화면에는 '민준'으로 보임).
PEOPLE = {"아빠": ("아빠", "glasses", "ROW_1_LEFT", "민준"), "엄마": ("엄마", "healing", "ROW_1_RIGHT", "엄마"),
          "서준": ("아들", "cap", "ROW_2_LEFT", "서준"), "하은": ("딸", "basic-small", "ROW_2_RIGHT", "하은")}
READ = {  # 15초 목소리 등록 문장(시안 05·06·12·15)
    "아빠": ["안녕, 나는 민준이야.", "우리 가족과 함께 여행하는 시간이 좋아.", "오늘은 바다를 보러 가고, 맛있는 것도 먹을 거야.", "함께 타는 순간을 오래 기억하고 싶어."],
    "엄마": ["안녕, 나는 엄마야.", "우리 가족과 함께 여행하는 시간이 좋아.", "오늘은 바다를 보러 가고, 맛있는 것도 먹을 거야.", "함께 타는 순간을 오래 기억하고 싶어."],
    "서준": ["나는 서준이야.", "바다에 가서 모래성을 만들 거야.", "나는 서준이야.", "바다에 가서 모래성을 만들 거야."],
    "하은": ["나는 하은이야.", "바다에 가서 모래성을 만들 거야.", "나는 하은이야.", "바다에 가서 모래성을 만들 거야."],
}
# 주행 대사. 도착 브리핑의 행동 항목은 서버·차 규칙(place-rules-v2, backend/api/todo-vectors.json의 '디자인:' 사례)이 이 문장에서 뽑는다:
# 하나로마트 = 먼저 할 일 화장실(하은) + 살 것 삼겹살 600g·귤 1봉지(엄마), 젤리 1봉지(서준), 탄산수 2병(아빠)
# 강릉 숙소 = 먼저 할 일 화장실(하은) · 잊지 말기 고기 냉장 보관(엄마) · 챙길 것 체크인하고 가방 내리기(아빠)
LINES = {
    "talk": [("서준", "아빠, 바다는 왜 짜?"), ("서준", "아빠, 아까부터 바다 보이는데?"), ("아빠", "아빠는 내비 보고 있었지."),
             ("하은", "그럼 바다는 우리가 봐 줄게!"), ("엄마", "마트에서 삼겹살 600g이랑 귤 한 봉지 사 가자")],
    "mart": [("서준", "마트에서 젤리 한 봉지 사자"), ("서준", "한 봉지인데 큰 봉지면 되지!"), ("아빠", "마트에서 탄산수 2병 사자"),
             ("하은", "하나로마트 가면 화장실 먼저 가야 돼")],
    "lodge": [("하은", "우리 내일도 같이 타면 안 돼?"), ("엄마", "도착하면 다 같이 맛있게 먹자"), ("엄마", "숙소에서 고기는 바로 냉장 보관해야 돼"),
              ("아빠", "숙소에서 체크인하고 가방 내려야 돼"), ("하은", "숙소 가면 화장실 먼저 가야 돼")],
}
FAR_LODGE = (37.7519, 128.8761)  # 강릉 경포 쪽(멀어서 '곧 도착'이 뜨지 않음). 22단계 '여행 계속'에서 다음 장소를 숙소로 둘 때
VOICE = os.environ.get("DEMO_VOICE") == "1"  # 실제 소리 넣기·내비 판정(기본 끔). 끄면 서버 시드 + 차 디버그 목업(오너 지시 11/15)
SEED = not VOICE
FONT = "/System/Library/Fonts/AppleSDGothicNeo.ttc"
HERE = (37.41272, 127.09468)  # 에뮬레이터 GPS(11/15 리허설 세션이 dumpsys location으로 읽음). 실행할 때 다시 읽는다
NEAR_M = float(os.environ.get("DEMO_NEAR_M", "200"))  # 시연 장소를 내비 위치에서 얼마나 떨어뜨릴지. 도착 판정(T113)은 250 m 안이어야 함
# 도착 전 카드를 띄울 남은 시간(초, 디버그 인자 --ei approachSeconds). 앱 기본은 300. GPS가 움직이지 않아 남은 시간이 줄지 않으니 넉넉히
APPROACH_S = os.environ.get("DEMO_APPROACH_S", "600")

# 흐름 → (티켓, 차 PR의 머리 브랜치 무늬). 상태는 실행할 때 gh로 읽는다(병합/열림/없음).
FLOWS = {"F1": ("#390 T142", r"T142-car"), "F2": ("#372 T133", r"T133-car"), "F3": ("#365 T130", r"T130-car-final"),
         "F4": ("#388 T141", r"T141-car"), "F5": ("#369 T132", r"T132-car-after"), "F6": ("#392 T143", r"T143-car"), "F7": ("#420 T150", r"T150-car")}
# 단계표: 번호, 이름(시안), 원본 프레임, 창(전체·좁은 창·폰), 흐름. 시안의 번호와 같다. 곁가지 Q1–Q4는 'QR 참여 / 탑승자의 휴대폰'.
STEPS = [
    (1, "시작", "D01 2007:1123", "전체", "F1"), (2, "계정 만들기", "D02 2007:1162", "전체", "F1"), (3, "기록 동의", "D03 2007:1202", "전체", "F1"),
    (4, "내 프로필", "D04 2007:1245", "전체", "F1"), (5, "목소리 등록", "D05 2007:1287", "전체", "F1"), (6, "15초 녹음", "D06 2007:1390", "전체", "F1"),
    (7, "등록 완료", "D07 2007:1494", "전체", "F1"), (8, "가족 추가", "D08 2007:1533", "전체", "F2"), (9, "코드와 링크 초대", "D09 2007:1576", "전체", "F2"),
    ("Q1", "폰 / 동의와 참여", "D補 phoneJoin 2043:1711", "폰", "F2"), ("Q2", "폰 / 참여 완료", "D補 phoneJoined 2043:1743", "폰", "F2"),
    (10, "엄마 참여 확인", "D10 2007:1615", "전체", "F2"), (11, "서준 프로필", "D11 2007:1658", "전체", "F2"), (12, "서준 목소리", "D12 2007:1699", "전체", "F2"),
    (13, "다음 구성원", "D13 2007:1802", "전체", "F2"), (14, "하은 프로필", "D14 2007:1845", "전체", "F2"), (15, "하은 목소리", "D15 2007:1886", "전체", "F2"),
    # 16–16C(원본 Figma 시연 플로우 2045:1782): 전체 그룹 목록에서 동승 그룹 곁가지(G4 상세 → G2 초대)를 보고 우리 가족 · 좌석 선택 · 앉을 사람을 거쳐 출발(16D)
    (16, "전체 그룹 목록", "D16 2007:1989 · D16L 2097:4582 · C16 groups 2005:3085", "전체", "F2"),
    ("16G", "새 그룹 확인", "D16G 2094:4367 · C16G 2094:4746", "전체", "F2"), ("16I", "QR와 링크 초대", "D補 guestInvite 2026:2241 · C16 guestInvite 2005:3229", "전체", "F2"),
    ("16A", "우리 가족", "D16A 2026:2133 · C16A 2094:4566", "전체", "F2"), ("16B", "좌석 선택", "D16B 2026:2076 · C16B 2094:4626", "전체", "F2"),
    ("16C", "앉을 사람 선택", "D16C 2094:4307 · C16C 2094:4686", "전체", "F2"),
    (17, "주행 / 기록 중", "D17 2007:2042", "좁은 창", "F3"), (18, "기록 중지", "D17p 2014:1327", "좁은 창", "F3"), (19, "기록 재개", "D補 resumed 2026:1969", "좁은 창", "F3"),
    (20, "마트 도착 전", "D18 2007:2082", "좁은 창", "F4"), (21, "마트 도착 브리핑", "D19 2007:2110", "좁은 창", "F4"), (22, "여행 계속", "D20 2007:2145", "좁은 창", "F3"),
    (23, "숙소 도착 전", "D補 finalNear 2043:1835", "좁은 창", "F4"), (24, "최종 목적지 브리핑", "D補 finalBrief 2043:1890", "좁은 창", "F4"),
    (25, "음성 업로드", "D21 2007:2184", "전체", "F5"), (26, "대화 기록 확인", "D33 2019:2052", "전체", "F3"), (27, "추천 구간 확인", "D22 2007:2287", "전체", "F5"),
    (28, "파형에서 장면 선택", "D24 2007:2485", "전체", "F5"), (29, "숏폼 생성", "D25 2007:2584", "전체", "F5"), (30, "생성 결과", "D26 2007:2687", "전체", "F5"),
    (31, "갤러리", "D27 2007:2728", "전체", "F6"), (32, "타임라인", "D28 2007:2768", "전체", "F6"), (33, "지도", "D29 2007:2808", "전체", "F6"),
    (34, "숏폼 보기", "D31 2007:2886", "전체", "F6"), (35, "영상 내보내기", "D32 2007:2914", "전체", "F6"),
]
results = {}  # 단계 → {"result": 보임|없음|대체|건너뜀, "note", "shot"}
st = {}  # demo-state.json: 계정·토큰·그룹·여행. 저장소 밖 폴더에만 둔다


# ---- 서버(폰 역할과 시드) ------------------------------------------------------------------------------------
def api(method, path, body=None, token=None, raw=None, ctype="application/json"):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(API + path, data=data, method=method, headers={**({"Content-Type": ctype} if data is not None else {}),
                                                                                 **({"Authorization": f"Bearer {token}"} if token else {})})
    for attempt in range(40):  # 고정 서버(8800)는 develop이 바뀌면 다시 뜬다(npm ci 포함 수십 초). 그동안은 기다렸다 다시 보낸다
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                t = r.read(); return json.loads(t) if t else None
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"{method} {path} → {e.code} {e.read().decode(errors='replace')[:200]}") from None
        except urllib.error.URLError as e:
            if attempt == 39: raise
            note("server.wait", error=str(e.reason)); time.sleep(3)


def save():
    STATE.write_text(json.dumps(st, ensure_ascii=False, indent=1))


def supplied(name):
    """미리 둔 실제 녹음인지: OUT/inputs/<name>.wav가 있고, 합성(cap.fixture)이 늘 함께 남기는 설명 파일(<name>.json)이 없다(옛 T13 demo.py와 같은 규칙).
    녹음은 16 kHz 2채널 16비트(왼쪽 = 앞줄, 오른쪽 = 뒷줄)여야 한다. 저장소에는 넣지 않는다."""
    wav = OUT / "inputs" / f"{name}.wav"
    if not wav.exists() or (OUT / "inputs" / f"{name}.json").exists(): return False
    with wave.open(str(wav)) as w:
        if (w.getframerate(), w.getnchannels(), w.getsampwidth()) != (cap.R, 2, 2):
            raise SystemExit(f"{wav.name}는 16 kHz 2채널 16비트여야 합니다(지금 {w.getframerate()} Hz {w.getnchannels()}채널 {8 * w.getsampwidth()}비트)")
    return True


def voice_wav(who):
    """목소리 값을 만들 16 kHz 모노 WAV 바이트(서버가 같은 임베더로 값을 만든다, 1~20초). 미리 둔 실제 녹음(enroll-<이름>.wav)이 있으면
    그 두 채널을 섞어 쓰고 — 주행 대사도 실제 목소리면 등록도 같은 목소리여야 차 안 화자 식별이 맞는다 — 없으면 등록 문장을 합성한다."""
    import numpy as np
    if supplied(f"enroll-{who}"):
        with wave.open(str(OUT / "inputs" / f"enroll-{who}.wav")) as w: st2 = np.frombuffer(w.readframes(w.getnframes()), "<i2").reshape(-1, 2)
        x = st2.astype(np.int32).sum(axis=1).clip(-32768, 32767)[: cap.R * 18]; note("voice.given", who=who, seconds=round(len(x) / cap.R, 1))
    else:
        x = np.concatenate([np.concatenate([cap.say(s, PEOPLE[who][0]), np.zeros(cap.R // 3, "<i2")]) for s in READ[who]])[: cap.R * 18]
    path = OUT / "inputs" / f"voice-{PEOPLE[who][0]}.wav"; path.parent.mkdir(exist_ok=True)  # API용 모노(가상 마이크용 enroll-*.wav는 2채널)
    with wave.open(str(path), "wb") as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(cap.R); w.writeframes(x.astype("<i2").tobytes())
    return path.read_bytes()


def account(role, who):
    """계정 하나(이메일·비밀번호). 있으면 로그인(POST /sessions), 없으면 가입. 비밀번호는 폴더마다 새로 만들어 상태 파일에만 둔다."""
    a = st.setdefault(role, {})
    a.setdefault("email", os.environ.get(f"DEMO_{role.upper()}_EMAIL", f"{'minjun' if role == 'dad' else 'mom'}+{os.urandom(3).hex()}@example.com"))
    a.setdefault("password", "demo-" + os.urandom(6).hex())
    try: p = api("POST", "/sessions", {"email": a["email"], "password": a["password"], "device": "시연"})
    except RuntimeError: p = api("POST", "/accounts", {"email": a["email"], "password": a["password"], "name": PEOPLE[who][3], "character": PEOPLE[who][1], "device": "시연"})
    a.update(token=p["token"], id=p["id"]); save()
    return a


def ready_profile(role, who, voice=True):
    """계정 동의·이름·캐릭터, 목소리 값(서버가 WAV를 같은 임베더로 값으로 바꿈). 이미 된 것은 건너뛴다."""
    a = account(role, who)
    me = api("GET", "/profiles/me", token=a["token"])
    if me.get("name") != PEOPLE[who][3] or not me.get("consent"):
        api("PATCH", "/profiles/me", {"name": PEOPLE[who][3], "character": PEOPLE[who][1], "consent": True}, a["token"])
    if voice and not me.get("hasVoice"):
        api("POST", "/profiles/me/voice", raw=voice_wav(who), token=a["token"], ctype="audio/wav")
    note("seed.profile", role=role, who=who)
    return a


def family():
    """'우리 가족' 그룹(아빠가 대표). 없으면 만든다."""
    d = st["dad"]["token"]
    g = next((g for g in api("GET", "/groups", token=d)["items"] if g["kind"] == "family"), None) or api("POST", "/groups", {"name": "우리 가족", "kind": "family"}, d)
    st["group"] = g["id"]; save()
    return g


def mom_joins(code=None):
    """엄마의 폰(D補 phoneJoin → phoneJoined)과 같은 요청: 초대 미리보기 → 내 프로필로 그룹 참여. code가 없으면 새 초대를 만든다."""
    g = family()
    if any(m["profileId"] == st["mom"]["id"] for m in g["members"]): return g
    code = code or api("POST", f"/groups/{g['id']}/invites", token=st["dad"]["token"])["code"]
    if os.environ.get("DEMO_PHONE") == "manual":
        print(f"\n엄마 폰에서 여세요: http://<맥 주소>:{PORT}/?group={code}  (로그인 {st['mom']['email']} / 상태 파일의 비밀번호). 참여하면 이어 갑니다.")
        for _ in range(300):
            g = family()
            if any(m["profileId"] == st["mom"]["id"] for m in g["members"]): return g
            time.sleep(2)
        raise SystemExit("10분 동안 엄마가 참여하지 않았습니다")
    note("phone.preview", **api("GET", f"/group-invites/{code}"))
    return api("POST", f"/group-invites/{code}", {}, st["mom"]["token"])


def child(kid):
    """아이 프로필 하나(보호자 동의, 목소리 값). 차 화면이 만든 아이가 있으면 그대로 쓰고 목소리만 채운다."""
    g = family(); d = st["dad"]["token"]
    if not any(m["name"] == kid for m in g["members"]):
        g = api("POST", f"/groups/{g['id']}/children", {"name": kid, "character": PEOPLE[kid][1], "guardianConsent": True}, d)
    m = next(m for m in g["members"] if m["name"] == kid)
    if not m["hasVoice"]: api("POST", f"/groups/{g['id']}/members/{m['profileId']}/voice", raw=voice_wav(kid), token=d, ctype="audio/wav")


def children():
    """아이 둘과 네 사람의 좌석(시안 16: 아빠 운전석, 엄마 조수석, 서준 뒤 왼쪽, 하은 뒤 오른쪽)."""
    for kid in ("서준", "하은"): child(kid)
    g = family(); d = st["dad"]["token"]
    seat = {v[3]: v[2] for v in PEOPLE.values()}
    want = {m["profileId"]: seat[m["name"]] for m in g["members"] if m["name"] in seat}
    if any(m["seat"] != want.get(m["profileId"]) for m in g["members"] if m["profileId"] in want):
        # 맞바꾸기가 같은 자리 둘을 만들지 않게 먼저 모두 비우고 앉힌다(한 요청 안의 맞바꾸기는 서버가 커밋 때 검사)
        api("PUT", f"/groups/{g['id']}/seats", {"seats": {p: None for p in want}}, d)
        g = api("PUT", f"/groups/{g['id']}/seats", {"seats": want}, d)
    note("seed.family", members=[(m["name"], m["role"], m["seat"], m["hasVoice"], m["consent"]) for m in g["members"]])
    return g


GUEST = "주말 바다 친구들"  # 동승 그룹(C16G·C16I·C16L의 시연 데이터, F2 담당이 정한 시드)


def guest_group():
    """동승 그룹 '주말 바다 친구들': 만든 아빠 혼자 운전석, 초대 코드 하나(POST /groups {kind:guest} → PUT seats → POST invites). 있으면 그대로 쓴다."""
    d = st["dad"]["token"]
    g = next((g for g in api("GET", "/groups", token=d)["items"] if g["kind"] == "guest" and g["name"] == GUEST), None) \
        or api("POST", "/groups", {"name": GUEST, "kind": "guest"}, d)
    if not any(m["profileId"] == st["dad"]["id"] and m["seat"] == "ROW_1_LEFT" for m in g["members"]):
        g = api("PUT", f"/groups/{g['id']}/seats", {"seats": {st["dad"]["id"]: "ROW_1_LEFT"}}, d)
    if not g.get("invite"): g["invite"] = api("POST", f"/groups/{g['id']}/invites", {}, d)
    st["guest"] = g["id"]; save()
    note("seed.guest", name=g["name"], members=[(m["name"], m["seat"]) for m in g["members"]], invite=(g.get("invite") or {}).get("code"))
    return g


def seed():
    """시연 가족 전부(차 화면 01–16 없이): 엄마·아빠 계정, 동의, 목소리, 그룹, 엄마 참여, 아이 둘, 좌석, 동승 그룹."""
    ready_profile("mom", "엄마"); ready_profile("dad", "아빠")
    mom_joins(); g = children(); guest_group(); return g


def trip_tokens(code):
    """엄마의 폰이 여행에 다시 참가해 자기 참가자 토큰을 받는다(폰 P17, 같은 프로필이면 같은 참가자). 기록을 읽는 데 쓴다."""
    p = api("POST", f"/trips/{code}/participants", {}, st["mom"]["token"])
    st["trip"] = {"code": code, "mom": p["token"], "momId": p["id"]}; save()
    return p["token"]


# ---- 차 화면 ----------------------------------------------------------------------------------------------
NODE = re.compile(r'<node [^>]*?text="([^"]*)"[^>]*?class="([^"]*)"[^>]*?content-desc="([^"]*)"[^>]*?checkable="(\w+)"[^>]*?checked="(\w+)"[^>]*?enabled="(\w+)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')


def ui():
    """화면 트리의 칸(글, 종류, 체크, 켜짐, 자리). 글이 없는 그림 단추(C17 녹음 막대의 ⏸ '일시정지'·● '녹화 재개')는 접근성 이름(content-desc)을 글로 쓴다."""
    adb("shell", "uiautomator", "dump", "/data/local/tmp/t150-ui.xml")
    return [(t or d, c, k == "true", e == "true", tuple(map(int, b))) for t, c, d, k, _, e, *b in NODE.findall(adb("exec-out", "cat", "/data/local/tmp/t150-ui.xml"))]


def words():
    return [n[0] for n in ui() if n[0]]


def seen(*needles):
    w = words(); return next((x for x in needles if any(x in t for t in w)), None)


SLOW = float(os.environ.get("DEMO_WAIT", "2"))  # 화면 트리 읽기(uiautomator dump)가 한 번에 4초 넘게 걸리는 바쁜 맥에서는 기다림을 늘린다


def wait(needles, timeout=15):
    end = time.time() + timeout * SLOW
    while time.time() < end:
        if (got := seen(*needles)): return got
        time.sleep(1)
    return None


def tap(*labels, exact=True, timeout=8):
    """보이는 글이 labels 중 하나인 칸을 누른다(같은 글이 여럿이면 아래쪽 = 화면 아래 단추). 못 찾으면 False."""
    end = time.time() + timeout
    while True:
        for lab in labels:
            hit = [n for n in ui() if n[0] and (n[0] == lab if exact else lab in n[0]) and n[3]]
            if hit:
                x1, y1, x2, y2 = max(hit, key=lambda n: n[4][1])[4]
                adb("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2)); note("tap", text=lab); time.sleep(1.5)
                return True
        if time.time() > end: note("tap.miss", texts=list(labels)); return False
        time.sleep(1)


# Pleos 화면 자판(두벌식)의 글쇠 자리(2560×1440, 11/15 emulator-5586 캡처에서 잼). adb input text는 한글을 넣지 못해 글쇠를 누른다.
KEYS = {**{k: (x, 919) for k, x in zip("ㅂㅈㄷㄱㅅㅛㅕㅑㅐㅔ", (557, 666, 774, 883, 992, 1101, 1210, 1318, 1427, 1536))},
        **{k: (x, 1028) for k, x in zip("ㅁㄴㅇㄹㅎㅗㅓㅏㅣ", (666, 774, 883, 992, 1101, 1210, 1318, 1427, 1536))},
        **{k: (x, 1137) for k, x in zip("ㅋㅌㅊㅍㅠㅜㅡ", (719, 828, 937, 1046, 1155, 1263, 1372))}}


def jamo(word):
    """한글 음절을 두벌식으로 칠 낱자로(받침 하나짜리까지). 자판에 없는 낱자가 있으면 None."""
    cho, jung, jong = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ", "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ", " ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"
    out = []
    for ch in word:
        c = ord(ch) - 0xAC00
        if not 0 <= c < 11172: return None
        out += [cho[c // 588], jung[c % 588 // 28]] + ([jong[c % 28]] if c % 28 else [])
    return out if all(j in KEYS for j in out) else None


def type_into(i, value):
    """i번째 입력 칸에 글을 넣고, 칸에 그 글이 들어갔는지 화면에서 확인한다. 영문은 adb input text, 한글은 화면 자판의 글쇠를 누른다."""
    fields = [n for n in ui() if "EditText" in n[1]]
    keys = None if value.isascii() else jamo(value)
    if len(fields) <= i or (not value.isascii() and keys is None): return False
    x1, y1, x2, y2 = fields[i][4]
    adb("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2)); time.sleep(1)
    # 칸에 남은 글(자동 완성으로 채워진 계정·저장된 비밀번호 등)을 먼저 지운다: 끝으로 가서 지우기 60번
    adb("shell", "input", "keyevent", "KEYCODE_MOVE_END"); adb("shell", "input", "keyevent", *["KEYCODE_DEL"] * 60); time.sleep(0.5)
    if keys is None: adb("shell", "input", "text", shlex.quote(value).replace(" ", "%s"))
    else:
        for k in keys: adb("shell", "input", "tap", *map(str, KEYS[k])); time.sleep(0.3)
    time.sleep(0.5); hide_keyboard()
    got = [n[0] for n in ui() if "EditText" in n[1]]
    ok = len(got) > i and (got[i] == value or not value.isascii() and value in got[i] or len(got[i]) == len(value) and set(got[i]) <= set("•●*"))  # 비밀번호 칸은 점으로
    note("type", field=i, ok=ok, korean=keys is not None)
    return ok


def hide_keyboard():
    """화면 자판(Pleos 한글 자판)이 아래 단추를 가리므로 닫는다. 자판이 떠 있을 때만 뒤로(BACK) — 아니면 화면이 뒤로 간다."""
    if "mIsInputViewShown=true" in adb("shell", "dumpsys", "input_method"): adb("shell", "input", "keyevent", "4"); time.sleep(1)


def launch(*extras, restart=False):
    """앱을 연다(디버그 인자). 이미 나눈 창이면 가치타가 왼쪽 넓은 창으로 옮겨 가니 부른 쪽이 다시 나눈다(T112).
    앱은 singleTop이라 떠 있으면 onNewIntent만 받는다: route·stops는 거기서 읽지만 profileToken·family·onboarding은 onCreate에서만 읽으므로
    그 인자는 restart=True(-S, 앱을 껐다 켬 — 녹음 중에는 쓰지 않음)로 준다."""
    # adb shell은 인자를 이어 붙여 기기의 셸에 넘기므로 값을 따옴표로 감싼다('강릉 숙소'의 띄어쓰기에서 잘려 뒤의 --es stops가 사라졌었음, 리허설 run1)
    adb("shell", "am", "start", "--user", "10", *(["-S"] if restart else []), "-n", f"{PKG}/.MainActivity", "--es", "server", CAR_SERVER, *map(shlex.quote, extras))
    time.sleep(6 if restart else 4)


def windows():
    """앱 영역 창 경계 {패키지: (x1, y1, x2, y2)}(dumpsys activity containers). Pleos 홈 화면이 정한다."""
    got, task = {}, None
    for line in adb("shell", "dumpsys", "activity", "containers").splitlines():
        m = re.search(r" Task=\d+ type=standard .* bounds=\[(\d+),(\d+)\]\[(\d+),(\d+)\]", line)
        if m: task = tuple(map(int, m.groups())); continue
        m = re.search(r"ActivityRecord\{\S+ u10 ([\w.]+)/", line)
        if m and task: got.setdefault(m.group(1), task); task = None
    return got


def split():
    """순정 내비 왼쪽, 가치타 오른쪽 1:1(시안 '좁은 창 / 내비 옆'). 앱이 창을 나누는 API는 없어 운전자의 창 바 손짓을 흉내 낸다
    (2560×1440 에뮬레이터, 11/14 T112 실측과 11/15 리허설 세션이 5558에서 확인한 좌표: 넓은 창의 오른쪽 끝 ⋮를 끌면 나뉘고, 가운데 ⋮를 누르면 좌우가 바뀜)."""
    if NAV not in windows():  # 내비를 앞에 둔 뒤 가치타를 열면 가치타가 넓은 창(2:0)으로 뜬다
        adb("shell", "am", "start", "--user", "10", "-n", cap.NAVI); time.sleep(3)
        adb("shell", "am", "start", "--user", "10", "-n", f"{PKG}/.MainActivity"); time.sleep(3)
    w = windows()
    if PKG in w and w[PKG][2] - w[PKG][0] > 1200:
        adb("shell", "input", "swipe", "2544", "720", "1700", "720", "1200"); time.sleep(3); w = windows()
    if PKG in w and NAV in w and w[PKG][0] < w[NAV][0]:
        adb("shell", "input", "tap", "1706", "720"); time.sleep(3); w = windows()
    ok = PKG in w and NAV in w and w[NAV][0] < w[PKG][0] and w[PKG][2] - w[PKG][0] < 1200
    note("split", ok=ok, windows={k: list(v) for k, v in w.items() if k in (PKG, NAV)})
    return ok


def unsplit():
    """나눈 창을 가치타 하나(2:0)로: 가운데 ⋮를 왼쪽 끝까지 끈다(T112 ③)."""
    w = windows().get(PKG)
    if w and w[2] - w[0] < 1200: adb("shell", "input", "swipe", "1706", "720", "862", "720", "1200"); time.sleep(3)
    w = windows().get(PKG); note("unsplit", window=list(w) if w else None)
    return bool(w and w[2] - w[0] > 1200)


def speed(kmh):
    """Virtual Console 속도. P여도 5 km/h를 넘으면 주행 제한이 풀리지 않으므로 주차 전에 0으로."""
    try: urllib.request.urlopen(urllib.request.Request(f"{e2e.VC}/vehicle/controls?speed={kmh}&accelerator={20 if kmh else 0}&brake=0", method="PUT"), timeout=5).read()
    except Exception as x: note("speed.fail", error=str(x))
    note("speed", kmh=kmh)


def drive():
    gear("Drive"); speed(60); time.sleep(2)


def park():
    speed(0); time.sleep(1); gear("Park"); time.sleep(2)


# ---- 소리 ---------------------------------------------------------------------------------------------------
inj = None
clips = []  # 녹화와 섞을 때: {"part", "clip", "at_ms"}


FIXTURES = {**LINES, **{f"enroll-{who}": [(who, t) for t in READ[who]] for who in ("아빠",)}}


def prepare():
    """대사 WAV를 미리 합성하고(합성에 몇 초씩 걸려 넣을 때를 놓치지 않게) gRPC 연결을 열어 둔다. 남의 에뮬레이터면 넣지 않는다."""
    global inj
    if not grpc_is_ours():
        note("say.off", why=f"gRPC {os.environ['GACHITA_GRPC_PORT']}이 {os.environ['ANDROID_SERIAL']}의 것이 아님(-grpc로 켜지 않았거나 다른 에뮬레이터) — 대사를 넣지 않음"); return
    for name, lines in FIXTURES.items():
        if supplied(name): note("fixture.given", name=name); continue  # 미리 둔 실제 녹음은 덮어쓰지 않는다
        cap.fixture(name, [(PEOPLE[w][0], t) for w, t in lines], seconds=13 if name.startswith("enroll-") else None, lead=0.5, tail=1.0)  # 등록 녹음(15초)이 닫히기 전에 끝나게
    try: inj = cap.Injector()
    except SystemExit as e: note("say.off", why=str(e))


ENROLL_MAX_S = 14  # 차의 목소리 등록은 15초에 닫힌다. 그보다 긴 소리는 gRPC 넣기 큐에 남아 다음 넣기를 막고, 기록이 켜지면 받아 적힌다(리허설 run2)
injecting = threading.Lock()  # 넣기는 한 번에 하나. 앞의 것이 끝나기 전에 다음을 보내지 않는다


def injectable(name):
    """넣을 파일 이름. 등록용(enroll-*)은 앞 14초만 잘라 <name>-14s.wav로 따로 둔다(미리 둔 실제 녹음도 원본은 그대로 둠)."""
    if not name.startswith("enroll-"): return name
    with wave.open(str(OUT / "inputs" / f"{name}.wav")) as w:
        params, frames = w.getparams(), w.readframes(min(w.getnframes(), w.getframerate() * ENROLL_MAX_S))
    with wave.open(str(OUT / "inputs" / f"{name}-14s.wav"), "wb") as w: w.setparams(params); w.writeframes(frames)
    return f"{name}-14s"


def say(name):
    """미리 만든 대사를 가상 마이크에 넣는다. 우리 녹음이 열려 있을 때만(닫힌 채 넣으면 에뮬레이터가 멈춘 적이 있음, cap.Injector.play도 확인).
    앞의 넣기가 아직이면 60초까지 기다리고, 그래도 안 끝나면 넣지 않는다. 넣기가 completed가 아니면(FAILED_PRECONDITION 등) 크게 알린다."""
    if inj is None: note("say.skip", name=name, why="소리 넣기 꺼짐"); return False
    if not injecting.acquire(timeout=60):
        note("say.skip", name=name, why="앞의 넣기가 60초 넘게 끝나지 않음"); check(f"대사 {name} 넣기", False, why="앞의 넣기가 큐에 남음"); return False
    try:
        if not any("silenced:false" in l for l in cap.mic_holders()):
            note("say.skip", name=name, why="가치타가 녹음 중이 아님"); return False
        clip = injectable(name)
        try: at = inj.play(clip)
        except SystemExit as e: note("say.skip", name=name, why=str(e)); return False
        done = next((x for x in reversed(e2e.log) if x["step"] == "inject.done" and x.get("name") == clip), {})
        if done.get("result") != "completed":
            print(f"\n!!! 대사 '{name}'을 넣지 못했습니다: {done.get('result')} — 앞의 소리가 큐에 남았거나 녹음이 닫혔습니다\n", file=sys.stderr, flush=True)
            check(f"대사 {name} 넣기", False, result=done.get("result")); return False
        clips.append({"part": part, "clip": clip, "at_ms": at})
        return True
    finally:
        injecting.release()


def grpc_is_ours():
    """cap.Injector는 gRPC 포트로만 에뮬레이터를 고른다. 그 포트가 ANDROID_SERIAL의 에뮬레이터인지 실행 기록(pid_*.ini)으로 확인한다."""
    serial = os.environ["ANDROID_SERIAL"].removeprefix("emulator-")
    owners = []
    for ini in (pathlib.Path.home() / "Library/Caches/TemporaryItems/avd/running").glob("pid_*.ini"):
        kv = dict(l.split("=", 1) for l in ini.read_text().splitlines() if "=" in l)
        if kv.get("grpc.port") == os.environ["GACHITA_GRPC_PORT"]: owners.append(kv.get("port.serial"))
    return owners == [serial]  # 같은 gRPC 포트를 두 에뮬레이터가 적어 두었으면 어느 쪽에 닿을지 몰라 넣지 않는다


# ---- 단계 기록 ----------------------------------------------------------------------------------------------
part = 0  # 녹화 묶음: 1 = 01–16 전체, 2 = 17–24 좁은 창, 3 = 25–35 전체


def only(n):
    """DEMO_STEPS 범위 안의 단계인지(곁가지 Q는 앞 단계를 따름)."""
    lo, _, hi = os.environ.get("DEMO_STEPS", "1-35").partition("-")
    return int(lo) <= n <= int(hi or lo)


def step(n, needles, timeout=15, note_="", seeded=False):
    """단계 n의 화면 글(needles 중 하나)이 보이면 캡처하고 '보임'(시드·목업으로 띄운 화면이면 '시드'). 없으면 '없음'과 그 흐름의 PR 상태."""
    meta = next(s for s in STEPS if s[0] == n)
    got = wait(needles, timeout)
    shot = f"{n:02d}-{meta[1].replace(' / ', '-').replace(' ', '')}.png" if isinstance(n, int) else f"{n}-{meta[1].replace(' / ', '-').replace(' ', '')}.png"
    if got:
        e2e.shot(shot.removesuffix(".png"))
        results[n] = {"result": "시드" if seeded else "보임", "matched": got, "note": note_, "shot": shot}
    else:
        results[n] = {"result": "없음", "note": note_ or f"화면 글 {needles[0]!r}이 {timeout}초 안에 안 보임 — {flow_state(meta[4])}", "shot": None}
    check(f"{n} {meta[1]}", got, matched=got)
    return bool(got)


def mark(n, result, why):
    results[n] = {"result": result, "note": why, "shot": None}; note("step", n=n, result=result, why=why)


_prs = None


def flow_state(flow):
    """그 흐름의 차 PR 번호와 상태(gh). 머리 브랜치 이름의 티켓 번호로 찾는다. gh가 없으면 '확인 못 함'."""
    global _prs
    if _prs is None:
        r = subprocess.run(["gh", "pr", "list", "-R", REPO, "--state", "all", "--limit", "200", "--json", "number,state,headRefName"], capture_output=True, text=True)
        _prs = json.loads(r.stdout) if r.returncode == 0 else []
    ticket, pat = FLOWS[flow]
    hits = sorted((p for p in _prs if re.search(pat, p["headRefName"])), key=lambda p: -p["number"])
    pr = next((p for p in hits if p["state"] == "MERGED"), None) or next((p for p in hits if p["state"] == "OPEN"), None)
    return f"{flow} {ticket} 차 " + (f"PR #{pr['number']} {'병합됨' if pr['state'] == 'MERGED' else '병합 대기'}" if pr else ("PR 확인 못 함" if not _prs else "PR 없음"))


# ---- 단계 ---------------------------------------------------------------------------------------------------
def onboarding():
    """01–07 차 계정·온보딩(F1). 화면이 없으면 아빠 계정·동의·목소리를 API로 만든다(대체)."""
    if not step(1, ["가치타 시작하기", "함께 탄 순간을 오래"], 40):  # 설치·데이터 지우기·밤 모드 뒤 첫 화면은 늦게 뜬다
        for n in range(2, 8): mark(n, "없음", f"01 시작 화면이 없어 건너뜀 — {flow_state('F1')}")
        ready_profile("dad", "아빠"); mark(7, "대체", "아빠 계정·동의·목소리를 API로 만듦(차 화면 없음)"); return
    tap("가치타 시작하기")
    st.setdefault("dad", {}).setdefault("email", os.environ.get("DEMO_DAD_EMAIL", f"minjun+{os.urandom(3).hex()}@example.com"))
    st["dad"].setdefault("password", "demo-" + os.urandom(6).hex()); save()
    typed = type_into(0, st["dad"]["email"]) and type_into(1, st["dad"]["password"])
    step(2, ["가입하고 계속", "내 계정 만들기"], note_="" if typed else "이메일·비밀번호 칸을 찾지 못함")
    tap("가입하고 계속")  # 같은 이메일이 이미 있으면(409) 앱이 같은 칸으로 로그인한다(AccountApi.enter)
    # 차는 가입 때 이메일 앞부분을 임시 이름으로 둔다. 한글은 adb로 넣지 못하니 같은 계정에 로그인해 이름을 민준으로 정한다(실제 API)
    if step(3, ["동의하고 계속", "우리의 대화를 남기기 전에"]):
        account("dad", "아빠"); api("PATCH", "/profiles/me", {"name": PEOPLE["아빠"][3], "character": PEOPLE["아빠"][1]}, st["dad"]["token"])
        tap("동의하고 계속")
    step(4, ["목소리 등록하기", "나를 소개해 주세요"], note_="이름은 API로 '민준'(adb가 한글을 못 넣음)")
    tap("목소리 등록하기")
    said = []
    if step(5, ["녹음 시작", "15초만 들려주세요"]):
        tap("녹음 시작"); time.sleep(1)
        t = threading.Thread(target=lambda: said.append(say("enroll-아빠")), daemon=True); t.start()
        step(6, ["목소리를 듣고 있어요", "녹음 중"], 5)  # 누른 바로 뒤에 본다(15초 녹음 중에만 있는 글)
        t.join(30)  # 다 넣은 뒤에 멈춘다(녹음이 닫힌 채 넣으면 에뮬레이터가 멈춘 적이 있음)
        wait(["15 / 15초"], 25); tap("녹음 완료")  # 15초 녹음이 닫힐 때까지(시안 C07 글 '녹음 중  15 / 15초')
    step(7, ["목소리 등록 완료"], 20)
    account("dad", "아빠")
    if not any(said):  # 차가 아빠 목소리 대신 빈 소리를 등록했으면 화자 식별이 안 되므로 같은 합성 음성의 값으로 바꾼다(실제 API)
        api("POST", "/profiles/me/voice", raw=voice_wav("아빠"), token=st["dad"]["token"], ctype="audio/wav")
        results[7]["note"] = (results[7].get("note", "") + " 목소리 값은 API로(대사를 넣지 못함)").strip()


def family_steps():
    """08–16 가족·초대·아이·좌석(F2)과 QR 곁가지. 차 화면이 없으면 같은 것을 API로 만든다(대체)."""
    ready_profile("mom", "엄마")
    tap("가족 그룹 만들기", timeout=3)
    if not wait(["우리 가족 추가", "가족 계정 초대하기", "엄마 계정 초대하기"], 8): open_family()
    if not step(8, ["우리 가족 추가", "가족 계정 초대하기", "엄마 계정 초대하기"], 10):
        for n in (9, "Q1", "Q2", 10, 11, 12, 13, 14, 15, 16): mark(n, "없음", f"08 가족 추가 화면이 없어 건너뜀 — {flow_state('F2')}")
        mom_joins(); children(); mark(16, "대체", "그룹·엄마 참여·아이·목소리·좌석을 API로 만듦(차 화면 없음)"); return False
    tap("가족 계정 초대하기", "엄마 계정 초대하기")
    code = None
    if step(9, ["초대 코드", "코드 복사"]):
        code = next((m.group(0) for t in words() for m in [re.search(r"FAMILY-\d{4}", t)] if m), None)
        results[9]["note"] = f"초대 코드 {code}(서버가 4자리를 무작위로 고름, 시안은 FAMILY-2714)"
    mom_joins(code)
    for q in ("Q1", "Q2"): mark(q, "폰 역할", "엄마 폰의 요청(GET·POST /group-invites)을 스크립트가 보냄" if os.environ.get("DEMO_PHONE") != "manual" else "폰에서 손으로 참여")
    tap("엄마 참여 확인", "참여 확인")
    step(10, ["함께해요", "엄마 계정 연결 완료"])
    for i, kid in enumerate(("서준", "하은")):
        tap("아이 프로필 만들기", "서준 프로필 만들기", "하은 프로필 만들기")
        typed = type_into(0, kid)
        step(11 + 3 * i, ["아이 프로필 만들기", "보호자가 이름과 캐릭터"], note_="" if typed else "아이 이름을 화면 자판으로 넣지 못함 → API로 만듦")
        if typed and tap("동의하고 목소리 등록"):
            step(12 + 3 * i, [f"{kid}의 목소리 등록"]); wait(["가족 그룹에 저장"], 20); tap("가족 그룹에 저장")
            child(kid)  # 차 화면은 아이 목소리를 진행만 그린다(F2 mock) → 같은 합성 음성의 값을 실제 API로
        else:
            adb("shell", "input", "keyevent", "4"); mark(12 + 3 * i, "대체", f"{kid} 아이 프로필·목소리를 API로(차 화면은 이름 입력 단계)")
            child(kid); open_family()  # 가족 화면은 열 때만 그룹을 읽는다
        if i == 0: step(13, ["까지 준비됐어요"])
    children(); guest_group(); open_family()  # 좌석과 동승 그룹을 실제 API로 맞추고 다시 읽는다 → 모두 자리가 있으면 '우리 가족' 좌석(C43)
    tap("함께 타는 중", timeout=6)  # 주차 중 위 탭 '함께 타는 중' → 전체 그룹 목록(C16 groups)
    step(16, ["내 동승 그룹", "+ 새 그룹 만들기"], note_=f"우리 가족 + 시드 동승 그룹 '{GUEST}'(D16L과 같은 목록)")
    return group_screens()


def group_screens():
    """16 전체 그룹 목록에서 동승 그룹(16G 상세 → 16I 초대)과 우리 가족(16A 상세 → 16B 좌석 → 16C 앉을 사람)을 거쳐 '이 그룹과 출발'(16D).
    목록이 없으면(옛 판) 우리 가족 좌석의 '이 가족과 출발'로 떠난다."""
    if not seen("내 동승 그룹"):
        for n in ("16G", "16I", "16A", "16B", "16C"): mark(n, "없음", "전체 그룹 목록이 없음 — " + flow_state("F2"))
        return tap("이 가족과 출발")
    tap(GUEST); step("16G", ["초대 코드, QR 또는 링크로 함께할 사람을 초대해 주세요."], note_="아빠 혼자인 동승 그룹(시드)")
    tap("동승자 초대하기"); step("16I", ["초대 코드와 링크를 만들었어요"], note_="TRIP- 초대 코드(서버가 고름)")
    tap("그룹으로 돌아가기"); tap("전체 그룹 보기", timeout=4)
    tap("우리 가족 보기"); step("16A", ["오늘 함께 탈 가족과 좌석을 확인해 주세요."])
    tap("좌석 배정"); step("16B", ["좌석을 누르고 앉을 사람을 선택해 주세요."])
    tap("빈자리"); step("16C", ["누가 앉나요?", "선택한 좌석"], note_="뒤 가운데 빈자리를 눌러 가족 목록만 보이고 바꾸지 않음")
    tap("좌석 배정으로"); tap("그룹으로")  # 시안 좌석 그대로 두고 상세로
    return tap("이 그룹과 출발", "이 가족과 출발")


# 스크립트가 누르거나 기다리는 차 화면 글. --check가 앱 소스에 그대로 있는지 본다(에뮬레이터 없이 화면 글이 바뀐 것을 잡음).
TAPS = {"Onboarding.kt": ["가치타 시작하기", "가입하고 계속", "동의하고 계속", "목소리 등록하기", "녹음 시작", "녹음 완료", "가족 그룹 만들기"],
        "Family.kt": ["가족 계정 초대하기", "아이 프로필 만들기", "참여 확인", "동의하고 목소리 등록", "가족 그룹에 저장", "이 가족과 출발", "내 동승 그룹", "+ 새 그룹 만들기", "초대 코드, QR 또는 링크로 함께할 사람을 초대해 주세요.", "동승자 초대하기", "초대 코드와 링크를 만들었어요", "그룹으로 돌아가기", "전체 그룹 보기", "우리 가족 보기", "오늘 함께 탈 가족과 좌석을 확인해 주세요.", "좌석 배정", "좌석을 누르고 앉을 사람을 선택해 주세요.", "빈자리", "누가 앉나요?", "좌석 배정으로", "그룹으로", "이 그룹과 출발", "우리 가족 추가", "코드 복사", "까지 준비됐어요"],
        "Drive.kt": ["일시정지", "녹화 재개", "방금 받아 적은 말", "멈추기 전 마지막 대화", "도착까지 약"],
        "Arrival.kt": ["먼저 할 일과 살 것을 모았어요", "잊지 말고 살 것", "계속", "여행 마치고 기록 보기", "내리기 전, 할 일과 챙길 것"],
        "AfterTrip.kt": ["오늘의 주행을 기록했어요", "남기고 싶은 순간을 골라요", "장면을 선택해 주세요", "콘텐츠를 만들어요", "콘텐츠 생성 중", "순간이 완성됐어요", "콘텐츠 기록 보기"],
        "Contents.kt": ["우리 가족 / 차량과 폰에서 이어보기", "갤러리", "타임라인", "지도", "주행 지도 자세히 보기 →", "이 장면 보기", "영상 내보내기", "영상이 준비됐어요", "콘텐츠 기록으로"]}


def check_labels():
    """TAPS의 글이 앱 소스(frontend/car/app/src/main)에 있는지. 없으면 그 글과 파일을 적고 종료 코드 1."""
    src = pathlib.Path(__file__).resolve().parent / "app/src/main/java/io/github/teampitcrew/gachita"
    missing = [(f, t) for f, ts in TAPS.items() for t in ts if t not in (src / f).read_text()]
    for f, t in missing: print(f"없음: {f}: {t!r}")
    print(f"화면 글 {sum(map(len, TAPS.values()))}개 중 없는 것 {len(missing)}개")
    return not missing


def open_family():
    """가족 화면(F2)을 실제 그룹으로 연다. 차 로그인(F1)과 가족 화면이 아직 따로라 디버그 인자로 아빠의 프로필 토큰을 준다(F2 PR의 mock 경로)."""
    launch("--es", "profileToken", st["dad"]["token"], "--ez", "family", "true", "--ez", "onboarding", "false", restart=True)  # 가족 화면은 열 때 그룹을 읽는다


def start_trip(from_family):
    """여행 시작. 가족 화면의 '이 가족과 출발'(그룹 여행) 뒤 기록 시작. 없으면 develop의 옛 '여행 만들기'(가족 넷 손님)로 대체."""
    code = None
    if from_family:
        time.sleep(4); trips = api("GET", "/profiles/me/trips", token=st["dad"]["token"])["items"]
        code = trips[0]["code"] if trips and trips[0].get("status") != "ended" else None
    if not code:
        launch("--ez", "onboarding", "false", restart=True); tap("함께 타는 중", timeout=3)
        if seen("새 여행 시작"): tap("새 여행 시작")  # 앱 데이터를 지우지 않으므로 지난 여행이 끝난 채 남아 있을 수 있다
        e2e.tap_make(); time.sleep(5)
        consent_on_car()
        try: code = e2e.trip_code()
        except RuntimeError: code = None
        mark(16, "대체", "옛 여행 만들기(가족 넷 손님, 프로필 없음 → 화자 식별 없음)로 여행을 만듦")
    if code:
        st["trip"] = {"code": code}; save()
        if from_family: trip_tokens(code)
    tap("함께 타는 중", timeout=3); tap("기록 시작", timeout=6)  # 모두 동의면 주차 중 '기록 시작'(자동 기록이 들어오면 저절로)
    note("trip", code=code, recording=wait(["아래 버튼으로 언제든 멈출 수 있어요"], 20))
    return code


def consent_on_car():
    """develop의 옛 경로(대체): '동승자 설정' → 사람마다 '본인 동의 설정' → '본인 동의 켜기'. 차가 참가시킨 사람만 켤 수 있다(T68)."""
    if not tap("동승자 설정", timeout=4): return False
    for i in range(len(PEOPLE)):
        rows = sorted((n for n in ui() if n[0] == "본인 동의 설정"), key=lambda n: n[4][1])
        if i >= len(rows): break
        x1, y1, x2, y2 = rows[i][4]; adb("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2)); time.sleep(1.5)
        tap("본인 동의 켜기", timeout=4)
        adb("shell", "input", "keyevent", "4"); time.sleep(1.5)  # 동의 화면 → 동승자 목록
    adb("shell", "input", "keyevent", "4"); time.sleep(1.5)  # 동승자 목록 닫기
    return True


# ---- 시드 시나리오(오너 지시 11/15: 시연 동안은 화자 분리와 전체 시나리오를 목업 데이터로) ----------------------------------
# 서버에는 실제 API로 받아 적은 말(참가자 id + speakerMethod device-voice = 화자 분리 결과)·장소·도착 브리핑·장면·영상을 넣고,
# 차 화면 17–24는 차의 디버그 목업(--es f4 drive|drivePaused|driveResumed|near|mart|driveContinue|finalNear|final)으로 시안 그대로 띄운다.
# 소리 넣기와 내비 판정은 DEMO_VOICE=1일 때만(위 drive_steps). 동의 없는 녹음·토큰 없는 개인정보·원음 전체 업로드는 하지 않는다.
SEED_LINES = {  # 단계별 서버 기록본(시안 17·26·27의 말 + 도착 브리핑 항목이 나오는 말). (누구, 말, 위도, 경도)
    "A": [("서준", "아빠, 바다는 왜 짜?"), ("서준", "아빠, 아까부터 바다 보이는데?"), ("아빠", "아빠는 내비 보고 있었지."), ("하은", "그럼 바다는 우리가 봐 줄게!"),
          ("엄마", "마트에서 고기랑 과일도 사 가자.")],
    "B": [("서준", "마트에서 젤리 한 봉지 사자"), ("서준", "한 봉지인데 큰 봉지면 되지!"), ("엄마", "마트에서 삼겹살 600g이랑 귤 한 봉지 사 가자"),
          ("아빠", "마트에서 탄산수 2병 사자"), ("하은", "하나로마트 가면 화장실 먼저 가야 돼")],
    "C": [("하은", "우리 내일도 같이 타면 안 돼?"), ("엄마", "숙소에 가서 맛있게 먹자"), ("엄마", "숙소에서 고기는 바로 냉장 보관해야 돼"),
          ("아빠", "숙소에서 체크인하고 가방 내려야 돼"), ("하은", "숙소 가면 화장실 먼저 가야 돼")],
}
SEED_AT = {"A": (37.6981, 128.7633), "B": (37.7482, 128.8559), "C": (37.7598, 128.8917)}  # 동해고속도로 → 하나로마트 가는 길 → 숙소 가는 길(지도 선)
SEED_PLACES = {"출발": (37.41272, 127.09468), "하나로마트": (37.7519, 128.8761), "강릉 숙소": (37.7645, 128.8996)}
SEED_SCENES = [("아빠보다 빠른 서준의 정답", "A", 1, 32), ("내일도 같이 타면 안 돼?", "C", 0, 29)]  # 제목, 묶음, 첫 줄 번호, 길이(초, 시안 30)


def trip_people(code):
    """여행 참가자 {부르는 이름: 참가자}. 그룹 여행은 프로필 이름(민준·엄마·서준·하은), 옛 여행은 아빠·엄마·서준·하은."""
    ps = api("GET", f"/trips/{code}")["participants"]
    by = {p["name"]: p for p in ps}
    return {who: by.get(PEOPLE[who][3]) or by.get(who) for who in PEOPLE}


def seed_status(code, status):
    api("PATCH", f"/trips/{code}", {"status": status}, st["trip"].get("mom"))


def seed_lines(code, phase):
    """그 묶음의 말을 여행 기록본에 올린다(엄마 폰의 참가자 토큰, 기기 이름 demo-seed). 말마다 말한 사람(participantId)과 좌석 구역을 붙인다."""
    tok, ppl = st["trip"]["mom"], trip_people(code)
    gen = api("GET", f"/trips/{code}").get("generation", 1)
    now, la, ln = int(time.time() * 1000), *SEED_AT[phase]
    seq = st["trip"].get("seq", 0)
    items, ats = [], []
    for i, (who, text) in enumerate(SEED_LINES[phase]):
        p, at = ppl[who], now + i * 6000
        items.append({"seq": seq + i + 1, "at": at, "endAt": at + 2500, "text": text, "generation": gen, "lat": la + i * 0.0004, "lng": ln + i * 0.0006,
                      **({"participantId": p["id"], "speakerMethod": "device-voice", "speakerConfidence": 0.93, "seatArea": p["seat"]} if p else {})})
        ats.append(at)
    api("POST", f"/trips/{code}/utterances", {"device": "demo-seed", "generation": gen, "items": items}, tok)
    st["trip"].update(seq=seq + len(items), **{f"at{phase}": ats}); save()
    note("seed.lines", phase=phase, lines=len(items))


def seed_place(code, kind, name, eta=None):
    la, ln = SEED_PLACES[name]
    api("POST", f"/trips/{code}/places", {"kind": kind, "name": name, "lat": la, "lng": ln, "at": int(time.time() * 1000), **({"etaSeconds": eta} if eta else {})}, st["trip"]["mom"])


def seed_arrive(code, name):
    """도착(장소 기록) → 주차 → 도착 브리핑(폰 P20·finalBrief가 읽는 서버 상태). 위치는 그 장소 좌표(시연)."""
    la, ln = SEED_PLACES[name]
    seed_place(code, "arrived", name)
    seed_status(code, "parked")
    gen = api("GET", f"/trips/{code}").get("generation", 1)
    b = api("POST", f"/trips/{code}/arrival-briefing", {"generation": gen, "place": {"name": name, "lat": la, "lng": ln}, "position": {"lat": la, "lng": ln},
                                                         "parked": True, "observedAt": int(time.time() * 1000), "source": "browser"}, st["trip"]["mom"])
    note("seed.briefing", place=name, eligible=b.get("eligible"), items=len(b.get("items", [])))


def seed_contents(code):
    """콘텐츠 기록(31–35)용 장면 두 개: 장면(POST /moments) → 장면 소리(합성 음성 WAV, POST /recordings) → 서버 원본 스냅샷 →
    9:16 영상(ffmpeg, 제목 글자 + 그 소리) → 기본 영상 보관(POST /short-assets). 여행이 주차·끝난 뒤에만 된다."""
    import numpy as np
    tok = st["trip"]["mom"]; made = []
    have = {c.get("momentId") for c in api("GET", f"/trips/{code}/contents", token=tok).get("contents", [])}
    for title, phase, first, seconds in SEED_SCENES:
        ats = st["trip"].get(f"at{phase}")
        if not ats: continue
        frm = ats[first] - 1000
        m = api("POST", f"/trips/{code}/moments", {"at": ats[first], "from": frm, "to": frm + seconds * 1000, "label": title,
                                                   "lat": SEED_AT[phase][0], "lng": SEED_AT[phase][1]}, tok)
        if m["id"] in have: continue
        x = np.zeros(cap.R * seconds, "<i2")  # 장면 구간의 말을 그 시각 자리에 합성해 놓는다
        for (who, text), at in zip(SEED_LINES[phase], ats):
            o = int((at - frm) / 1000 * cap.R)
            if 0 <= o < len(x): v = cap.say(text, PEOPLE[who][0])[: len(x) - o]; x[o:o + len(v)] = v
        wav = OUT / "inputs" / f"scene-{m['id']}.wav"
        with wave.open(str(wav), "wb") as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(cap.R); w.writeframes(x.tobytes())
        gen = api("GET", f"/trips/{code}").get("generation", 1)
        api("POST", f"/trips/{code}/recordings?moment={m['id']}&generation={gen}&from={frm}", raw=wav.read_bytes(), token=tok, ctype="audio/wav")
        src = api("GET", f"/trips/{code}/short-assets/source?moment={m['id']}", token=tok)
        mp4 = OUT / "inputs" / f"scene-{m['id']}.mp4"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"color=c=0x1c1a17:s=720x1280:d={src['seconds']}", "-i", str(wav),
                        "-vf", f"drawtext=fontfile={FONT}:text='{title}':fontsize=48:fontcolor=0xf4f1ec:x=(w-tw)/2:y=h*0.42",
                        "-t", str(src["seconds"]), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "24", "-c:a", "aac", "-ar", "44100", "-ac", "1", str(mp4)], check=True)
        api("POST", f"/trips/{code}/short-assets?moment={m['id']}&generation={src['generation']}&sourceHash={src['sourceHash']}&key=demo-{m['id']}-{os.urandom(4).hex()}",
            raw=mp4.read_bytes(), token=tok, ctype="video/mp4")
        made.append(title)
    note("seed.contents", made=made)
    return made


def f4(state, *extra):
    """차의 디버그 목업 화면(--es f4 …, F4·T150). 앱을 다시 열면 가치타가 왼쪽 넓은 창으로 가므로 다시 나눈다."""
    launch("--es", "f4", state, *extra); split()


def drive_steps_seed(code):
    """17–24(시드): 서버 상태는 실제 API로, 차 화면은 디버그 목업으로. 단계마다 '시드'."""
    if not st.get("trip", {}).get("mom"):
        for n in range(17, 25): mark(n, "없음", "시드에 쓸 참가자 토큰이 없음(가족 그룹 여행이 아님)")
        return
    rec_part(2)
    if not split(): note("split.fail")
    drive(); seed_status(code, "driving"); seed_place(code, "start", "출발"); seed_place(code, "destination", "강릉 숙소"); seed_lines(code, "A")
    f4("drive"); step(17, ["방금 받아 적은 말"], note_="차 목업 drive + 서버 기록본 5줄(화자 분리)", seeded=True)
    f4("drivePaused"); step(18, ["멈추기 전 마지막 대화"], note_="차 목업 drivePaused", seeded=True)
    f4("driveResumed"); step(19, ["방금 받아 적은 말"], note_="차 목업 driveResumed", seeded=True)
    seed_lines(code, "B"); seed_place(code, "approaching", "하나로마트", eta=180)
    f4("near"); step(20, ["도착까지 약"], note_="차 목업 near + 서버 approaching", seeded=True)
    park(); seed_arrive(code, "하나로마트")
    f4("mart"); step(21, ["먼저 할 일과 살 것을 모았어요", "잊지 말고 살 것"], note_="차 목업 mart + 서버 도착 브리핑", seeded=True)
    tap("계속", timeout=4)
    drive(); seed_status(code, "driving"); seed_lines(code, "C")
    f4("driveContinue"); step(22, ["내일도 같이 타면 안 돼", "방금 받아 적은 말"], note_="차 목업 driveContinue + 서버 기록본 5줄", seeded=True)
    seed_place(code, "approaching", "강릉 숙소", eta=60)
    f4("finalNear"); step(23, ["도착까지 약"], note_="차 목업 finalNear + 서버 approaching", seeded=True)
    park(); seed_arrive(code, "강릉 숙소")
    f4("final"); step(24, ["여행 마치고 기록 보기", "내리기 전, 할 일과 챙길 것"], note_="차 목업 final + 서버 도착 브리핑", seeded=True)
    tap("여행 마치고 기록 보기", timeout=4)  # 목업은 화면만 넘기므로 여행은 폰의 '여행 끝내기'와 같은 요청으로 마친다
    seed_status(code, "ended")


def drive_steps(code):
    """17–24 순정 내비 옆 좁은 창(F3·F4). 대사·기어·도착(DEMO_VOICE=1, 실제 소리 넣기와 내비 판정)."""
    global part
    rec_part(2)
    if not split(): note("split.fail")
    tap("함께 타는 중", timeout=3); drive()
    wait(["아래 버튼으로 언제든 멈출 수 있어요"], 15)
    say("talk")
    step(17, ["방금 받아 적은 말"], 30, "대사 5줄(서준·아빠·하은·엄마)")
    tap("일시정지"); step(18, ["멈추기 전 마지막 대화"])
    tap("녹화 재개"); step(19, ["방금 받아 적은 말"], 8)
    say("mart")
    here = navi_here()
    # 길로 가까운 쪽: 11/15 emulator-5586 내비에서 GPS의 서쪽 200 m는 '1분 · 140m', 남쪽 200 m는 '1분 · 260m', 북·동쪽은 5–6분(1.5–1.7 km 돌아감)
    mart, lodge = near(here, 0, -NEAR_M), near(here, -NEAR_M, 0)
    launch("--es", "route", f"{lodge[0]},{lodge[1]},강릉 숙소", "--es", "stops", f"{mart[0]},{mart[1]},하나로마트", "--ei", "approachSeconds", APPROACH_S)
    split(); tap("함께 타는 중", timeout=3)
    step(20, ["도착까지 약"], 25, f"시연 경로: 경유 하나로마트 {mart}, 목적지 강릉 숙소 {lodge}(내비 위치 {here}에서 약 {NEAR_M:.0f} m)")
    park(); step(21, ["먼저 할 일과 살 것을 모았어요", "잊지 말고 살 것"], 25)
    if results[21]["result"] == "없음" and seen("도착했어요"): results[21] = {**results[21], "result": "다른 화면", "note": "develop의 T123 도착 카드(v1) — " + flow_state("F4")}
    tap("계속", "닫기", timeout=4)
    launch("--es", "route", f"{FAR_LODGE[0]},{FAR_LODGE[1]},강릉 숙소"); split(); tap("함께 타는 중", timeout=3)
    drive(); say("lodge")
    step(22, ["내일도 같이 타면 안 돼", "방금 받아 적은 말"], 20, "대사 5줄(하은·엄마·아빠)")
    launch("--es", "route", f"{lodge[0]},{lodge[1]},강릉 숙소", "--ei", "approachSeconds", APPROACH_S); split(); tap("함께 타는 중", timeout=3)
    step(23, ["도착까지 약"], 25)
    park(); step(24, ["여행 마치고 기록 보기", "내리기 전, 할 일과 챙길 것"], 25)
    if not tap("여행 마치고 기록 보기", timeout=4):
        # 차의 최종 브리핑이 없으면 폰의 '여행 끝내기'와 같은 요청으로 여행을 마친다(PATCH status ended)
        tok = st.get("trip", {}).get("mom")
        if tok: api("PATCH", f"/trips/{code}", {"status": "ended"}, tok); mark(24, "대체" if results[24]["result"] == "없음" else results[24]["result"], "여행은 폰의 '여행 끝내기' 요청으로 마침 — " + flow_state("F4"))


def navi_here():
    """내비의 지금 위치. DEMO_HERE(위도,경도) → 에뮬레이터 GPS(dumpsys location) → 11/15에 읽은 값. 내비는 GPS를 옮겨도 판교에 머문다(11/13)."""
    if os.environ.get("DEMO_HERE"): return tuple(map(float, os.environ["DEMO_HERE"].split(",")))
    m = re.search(r"Location\[gps (-?\d+\.\d+),(-?\d+\.\d+)", adb("shell", "dumpsys", "location"))
    here = (float(m.group(1)), float(m.group(2))) if m else HERE
    note("navi.here", lat=here[0], lng=here[1], source="gps" if m else "기본값")
    return here


def near(here, north_m, east_m):
    """here에서 북·동으로 몇 m 옮긴 좌표(가까운 거리라 평면으로 셈)."""
    import math
    return round(here[0] + north_m / 111_320, 6), round(here[1] + east_m / (111_320 * math.cos(math.radians(here[0]))), 6)


def after_steps(code):
    """25–35 전체 화면(F5·F3·F6)."""
    rec_part(3)
    if not unsplit(): note("unsplit.fail")
    tap("콘텐츠 기록", timeout=4)  # 주차·끝난 여행의 콘텐츠 기록 탭이 여행 마무리(C22)로 열린다(F5)
    step(25, ["오늘의 주행을 기록했어요", "전체 음성 업로드"], 12, "업로드 진행은 목업(원음 전체는 올리지 않음, PLAN 속도 우선 ③)")
    tap("대화 기록", timeout=4)
    step(26, ["의 부탁", "아까부터 바다 보이는데"], 15, "기록본의 시각·장소 머리, '{이름}의 부탁' 카드" + (" — 서버 시드 기록본(화자 분리)" if SEED else ""), seeded=SEED)
    tap("추천 장면 고르기", timeout=4)
    made = False
    if step(27, ["남기고 싶은 순간을 골라요", "장면을 선택해 주세요"], note_="추천 장면은 차가 시드 기록본에서 고름" if SEED else "", seeded=SEED):
        picks = [n for n in ui() if re.match(r"^[☐☑]\s*[13]\.\s", n[0])]  # 시안 행 글 '☐ 1. 제목'
        for n in (picks[:1] + picks[-1:]) if len(picks) > 1 else picks:
            x1, y1, x2, y2 = n[4]; adb("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2)); time.sleep(1)
        step(28, ["선택한 2개 생성", "선택한 "], seeded=SEED); tap("선택한 2개 생성", "선택한 ", exact=False)
        step(29, ["콘텐츠를 만들어요", "콘텐츠 생성 중"])
        step(30, ["순간이 완성됐어요"], 120); made = tap("콘텐츠 기록 보기")
    else:
        for n in (28, 29, 30): mark(n, "없음", "27 장면 고르기 화면이 없어 건너뜀 — " + flow_state("F5"))
    if not VOICE and st.get("trip", {}).get("mom"):  # 시드: 콘텐츠 기록 31–35의 장면·영상을 서버에 넣는다
        try: seeded = seed_contents(code)
        except (RuntimeError, subprocess.CalledProcessError) as e: seeded = []; note("seed.contents.fail", error=str(e)[:300])
        if seeded and made: tap("콘텐츠 기록", timeout=4); tap("갤러리", timeout=4)  # 새로 넣은 영상을 다시 읽게
    if not made: tap("콘텐츠 기록", timeout=4)  # 30 뒤에는 이미 콘텐츠 기록이 열려 있다(탭을 다시 누르면 여행 마무리로 감)
    sd = "서버 시드 장면·영상(seed_contents)" if SEED else ""
    if step(31, ["우리 가족 / 차량과 폰에서 이어보기", "갤러리"], 12, sd, seeded=SEED):
        # 보기 전환(갤러리·타임라인·지도, 시안 v3) → 지도 옆 '주행 지도 자세히 보기 →'(C36 상세) → '이 장면 보기'(C37) → 내보내기(C38)
        tap("타임라인"); step(32, ["타임라인"], note_=sd, seeded=SEED)
        tap("지도"); step(33, ["주행 지도 자세히 보기 →"], note_=sd, seeded=SEED)
        tap("주행 지도 자세히 보기 →"); tap("이 장면 보기", timeout=5)
        step(34, ["영상 내보내기"], note_=sd, seeded=SEED); tap("영상 내보내기")
        step(35, ["영상이 준비됐어요"], note_=sd, seeded=SEED); tap("콘텐츠 기록으로", timeout=4)
    else:
        for n in (32, 33, 34, 35): mark(n, "없음", "31 갤러리 화면이 없어 건너뜀 — " + flow_state("F6"))


# ---- 녹화(선택) --------------------------------------------------------------------------------------------
def rec_part(n):
    """DEMO_RECORD=1이면 묶음(1 전체 01–16, 2 좁은 창 17–24, 3 전체 25–35)마다 에뮬레이터 화면을 녹화한다. 넣은 대사는 나중에 섞는다."""
    global part
    if os.environ.get("DEMO_RECORD") == "1":
        if part: subprocess.run(ADB + ["emu", "screenrecord", "stop"], capture_output=True); time.sleep(2)
        subprocess.run(ADB + ["emu", "screenrecord", "start", str((OUT / f"part-{n}.webm").resolve())], capture_output=True)
        clips.append({"part": n, "clip": None, "at_ms": int(time.time() * 1000)})
    part = n


def mix():
    """녹화 묶음에 넣은 대사를 넣은 시각대로 섞는다(에뮬레이터 녹화에는 가상 마이크 소리가 들어가지 않음). 표시: 에뮬레이터 실행 화면 · 합성 음성."""
    for n in (1, 2, 3):
        src = OUT / f"part-{n}.webm"; t0 = next((c["at_ms"] for c in clips if c["part"] == n and c["clip"] is None), None)
        if not src.exists() or t0 is None: continue
        mine = [c for c in clips if c["part"] == n and c["clip"]]
        args = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src)] + sum((["-i", str(OUT / "inputs" / f"{c['clip']}.wav")] for c in mine), [])
        if mine:
            parts = [f"[{i + 1}:a]adelay={max(0, c['at_ms'] - t0)}:all=1[a{i + 1}]" for i, c in enumerate(mine)]
            parts.append("".join(f"[a{i + 1}]" for i in range(len(mine))) + f"amix=inputs={len(mine)}:normalize=0,alimiter=limit=0.9[a]")
            args += ["-filter_complex", ";".join(parts), "-map", "0:v", "-map", "[a]", "-c:a", "aac"]
        subprocess.run(args + ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "24", str(OUT / f"part-{n}.mp4")], check=False)


# ---- 표 ----------------------------------------------------------------------------------------------------
def table():
    rows = ["| 단계 | 이름 | 원본 프레임 | 창 | 흐름·차 PR | 결과 | 메모 |", "|---|---|---|---|---|---|---|"]
    for n, name, frame, window, flow in STEPS:
        r = results.get(n, {"result": "실행 안 함", "note": ""})
        rows.append(f"| {n} | {name} | {frame} | {window} | {flow_state(flow)} | {r['result']} | {r['note']} |")
    return "\n".join(rows)


def finish():
    (OUT / "steps.json").write_text(json.dumps({"server": API, "serial": os.environ["ANDROID_SERIAL"], "results": {str(k): v for k, v in results.items()},
                                                "clips": clips, "log": e2e.log}, ensure_ascii=False, indent=1))
    (OUT / "steps.md").write_text(table() + "\n")
    print(table())


def main(apk):
    threading.Thread(target=e2e.heartbeat, daemon=True).start()
    if apk != "-":
        out = subprocess.run(ADB + ["install", "--user", "10", "-r", "-g", apk], capture_output=True, text=True)
        if "Success" not in out.stdout + out.stderr: raise SystemExit(f"APK를 깔지 못했습니다: {(out.stdout + out.stderr).strip()[-200:]}")
    park()
    adb("shell", "cmd", "uimode", "night", "yes")  # 시안의 차 화면은 모두 어둡다. 앱은 시스템 밤 모드를 따른다
    if os.environ.get("DEMO_CLEAN") == "1":  # 01부터 보려면 앱 데이터(지난 여행·로그인)를 지운다. 기본은 지우지 않는다(오너 지시)
        adb("shell", "am", "force-stop", "--user", "10", PKG); adb("shell", "pm", "clear", "--user", "10", PKG)
    for perm in ("RECORD_AUDIO", "POST_NOTIFICATIONS"): adb("shell", "pm", "grant", "--user", "10", PKG, f"android.permission.{perm}")
    if VOICE: prepare()
    try:
        rec_part(1); launch(restart=True)  # 서버 주소(--es server)도 onCreate에서 읽는다
        if only(1): onboarding()
        else: launch("--ez", "onboarding", "false", restart=True); ready_profile("dad", "아빠")
        if only(8): from_family = family_steps()
        else: seed(); open_family(); from_family = tap("이 가족과 출발", timeout=10)
        code = start_trip(from_family)
        if only(17): (drive_steps if VOICE else drive_steps_seed)(code)
        if only(25): after_steps(code)
    finally:  # 중간에 멈춰도 주차·정지, 앱은 이 서버를 가리킨 채로
        subprocess.run(ADB + ["emu", "screenrecord", "stop"], capture_output=True); speed(0); gear("Park")
        launch()
        if os.environ.get("DEMO_RECORD") == "1": mix()
        finish()


if __name__ == "__main__":
    if len(sys.argv) < 3: raise SystemExit(__doc__)
    OUT.mkdir(parents=True, exist_ok=True)
    st.update(json.loads(STATE.read_text()) if STATE.exists() else {})
    if sys.argv[1] == "--plan": print(table())
    elif sys.argv[1] == "--seed": seed(); print(json.dumps({k: v for k, v in st.items() if k in ("group", "guest", "trip")}, ensure_ascii=False))
    elif sys.argv[1] == "--check": sys.exit(0 if check_labels() else 1)
    else: main(sys.argv[1])
