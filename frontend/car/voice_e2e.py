"""좌석 구역과 말한 사람 E2E(T37): 출발 전 가족 넷이 목소리를 등록하고, 대화를 넣어 발화마다 좌석 구역(앞줄·뒷줄)과 말한 사람이 맞게 붙는지 센다.

준비: capture_e2e.py와 같다(Cold boot한 Pleos 에뮬레이터 -grpc 8556 -grpc-use-token -audio none, adb forward tcp:8088 tcp:8088, ./gradlew assembleDebug).
      서버는 여행 참가자 목소리 등록과 줄 대조(#65 계약, T38)가 있는 것을 띄운다.
실행: GACHITA_PORT=<서버 포트> python3 frontend/car/voice_e2e.py <APK> <저장소 밖 폴더> [문장 수]

- 넣는 소리는 macOS say(Yuna) 한 목소리의 음높이만 바꾼 합성 음성이다(아빠 0.84, 엄마 1.0, 아들 1.14, 딸 1.28). 사람 목소리가 아니다.
- 왼쪽 채널 = 앞줄(아빠·엄마), 오른쪽 = 뒷줄(서준 = 아들 목소리, 하은 = 딸 목소리). 에뮬레이터 마이크는 두 채널을 완전히 가른다(11/13). 실차는 다르다.
- 좌석 구역은 앱 로그(GachitaCapture '발화 N … 구역 0|1|모름'), 말한 사람은 서버 기록(GET /utterances의 participantId)으로 본다.
- 결과는 OUT/results.json과 OUT/speakers.tsv(넣은 문장, 넣은 사람·줄, 받은 구역·사람).
"""
import io, json, re, sys, threading, time, urllib.request, wave
import numpy as np
import e2e, capture_e2e as cap
from e2e import ADB, PKG, OUT, adb, shot, texts, tap_text, tap_switch, gear, check, note, phone_join, phone_consent
from capture_e2e import PORT, TALK, Injector, fixture, wait_texts, wait_uploaded, server

VOICE = {"아빠": "아빠", "엄마": "엄마", "서준": "아들", "하은": "딸"}  # 차 가족 이름 → 넣는 목소리
LINES = ["오늘도 안전하게 같이 타고 가요.", "바다가 보이면 창문을 조금 열어 볼까요?"]  # 앱의 ENROLL_LINES와 같게


def zones():
    """앱 로그의 발화별 좌석 구역: 순번 → 0·1·None."""
    out = {}
    for c in cap.capture_log:
        m = re.match(r"발화 (\d+) .*구역 (\S+)", c["line"])
        if m: out[int(m.group(1))] = None if m.group(2) == "모름" else int(m.group(2))
    return out


def matched():
    """앱 로그에서 대조를 마친 순번(GachitaCapture '말한 사람 N …')."""
    return {int(m.group(1)) for c in cap.capture_log if (m := re.match(r"말한 사람 (\d+) ", c["line"]))}


def baseline(talk):
    """같은 합성 음성을 차를 거치지 않고 서버에 바로 등록·대조한 결과(새 여행 하나). 서버 임베더가 이 목소리들을 얼마나 가르는지의 기준."""
    api = f"http://localhost:{PORT}"
    def req(m, path, body=None, token=None, ctype="application/json"):
        data = json.dumps(body).encode() if isinstance(body, dict) else body
        r = urllib.request.Request(api + path, data=data, method=m, headers={"Content-Type": ctype, **({"Authorization": "Bearer " + token} if token else {})})
        with urllib.request.urlopen(r, timeout=20) as x: return json.loads(x.read() or b"{}")
    def wav(pcm):
        b = io.BytesIO(); w = wave.open(b, "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(pcm.astype("<i2").tobytes()); w.close(); return b.getvalue()
    def mono(path):
        return np.clip(np.frombuffer(wave.open(str(path)).readframes(10 ** 9), dtype="<i2").reshape(-1, 2).astype(np.int32).sum(1), -32768, 32767)
    code = req("POST", "/api/trips", {"title": "baseline"})["code"]
    seats = {"아빠": "ROW_1_LEFT", "엄마": "ROW_1_RIGHT", "서준": "ROW_2_LEFT", "하은": "ROW_2_RIGHT"}
    ppl = {n: (lambda p: (p["id"], p["token"]))(req("POST", f"/api/trips/{code}/participants", {"seat": s, "name": n, "consent": False})) for n, s in seats.items()}
    for n, (i, tok) in ppl.items():
        req("PATCH", f"/api/trips/{code}/participants/{i}", {"consent": True}, tok)
        req("POST", f"/api/trips/{code}/participants/{i}/voice", wav(mono(OUT / "inputs" / f"enroll-{n}.wav")), tok, "audio/wav")
    pcm = mono(OUT / "inputs" / "talk.wav"); names = {v[0]: k for k, v in ppl.items()}; out = []
    for u in talk["utterances"]:
        r = req("POST", f"/api/trips/{code}/voice-match?row={1 if u['channel'] == 'L' else 2}", wav(pcm[int(u["start_s"] * 16000):int(u["end_s"] * 16000)]), ppl["아빠"][1], "audio/wav")
        out.append((next(k for k, v in VOICE.items() if v == u["who"]), names.get(r.get("participantId")), r.get("confidence")))
    return out


def main(apk, n):
    threading.Thread(target=e2e.heartbeat, daemon=True).start()
    threading.Thread(target=cap.logcat, daemon=True).start()
    inj = Injector()
    for name, who in VOICE.items(): fixture(f"enroll-{name}", [(who, l) for l in LINES], lead=0.5, tail=0.5)
    talk = fixture("talk", TALK[:n], tail=4.0)
    note("apk", sha256=e2e.hashlib.sha256(open(apk, "rb").read()).hexdigest())
    note("install", out=e2e.subprocess.run(ADB + ["install", "--user", "10", "-r", "-g", apk], capture_output=True, text=True).stdout.strip()[-200:])
    gear("Park")
    adb("shell", "am", "force-stop", "--user", "10", PKG); adb("shell", "pm", "clear", "--user", "10", PKG)
    for perm in ("RECORD_AUDIO", "POST_NOTIFICATIONS"): adb("shell", "pm", "grant", "--user", "10", PKG, f"android.permission.{perm}")
    adb("shell", "am", "start", "--user", "10", "-n", f"{PKG}/.MainActivity", "--es", "server", f"http://10.0.2.2:{PORT}")
    wait_texts(lambda u: "서버 주소" in u, 30); tap_text("여행 만들기"); time.sleep(4)  # 설치 직후 첫 화면은 바쁜 기기에서 4초를 넘기기도 함
    code = next((t.split()[-1] for t in texts() if t.startswith("여행 코드")), None); note("trip", code=code)
    phone = phone_join(code)  # 서버 기록을 읽을 참가자(뒷자리 가운데, 목소리 등록 없음)
    wait_texts(lambda u: "일행 5명" in u, 15); tap_switch(); wait_texts(lambda u: "동의 대기" in " ".join(u), 10)
    phone_consent(code, phone, True)
    ui = wait_texts(lambda u: "● 기록 중" in u, 15)
    if not check("모두 동의하면 기록 중", "● 기록 중" in ui): raise SystemExit("수음이 열리지 않아 멈춥니다")
    shot("01-enroll-card"); note("ui", texts=ui)
    check("주차 중 기록이 시작되면 목소리 등록 카드에 이 차의 가족 넷", "출발 전 목소리 등록" in ui and all(x in ui for x in VOICE))
    # 1. 출발 전 목소리 등록: 사람마다 단추를 누르고 그 목소리로 두 문장을 넣는다
    for name in VOICE:
        tap_text(name); time.sleep(0.5)
        inj.play(f"enroll-{name}")
        ui = wait_texts(lambda u: any(t.endswith("목소리를 등록했어요") or "등록하지 못했어요" in t for t in u), 20); note("ui", texts=ui)
        check(f"{name} 목소리 등록", f"{name} 목소리를 등록했어요" in ui, ui=[t for t in ui if "등록" in t])
    shot("02-enrolled")
    # 2. 대화를 넣고 서버가 받은 발화마다 대조를 기다린다(올린 뒤 다음 조회)
    t0 = inj.play("talk"); time.sleep(3)  # play는 넣기가 끝날 때 돌아온다
    ids = {p["name"]: p["id"] for p in server(code)["participants"]}
    seqs = set(zones())  # 등록 문장은 보관함에 넣지 않으므로 이번 대화의 발화
    end = time.time() + 120
    while True:  # 모든 발화가 서버에 올라가고 앱이 그 발화마다 대조를 마칠 때까지(10초 조회마다 20건씩)
        items = wait_uploaded(code, phone, len(seqs), timeout=5)["items"]
        if ({u["seq"] for u in items} >= seqs and seqs <= matched()) or time.time() > end: break
        time.sleep(3)
    note("wait", utterances=len(seqs), uploaded=len(items), matched=len(matched() & seqs))
    z = zones()
    offset = cap.clock_offset()
    # 발화마다 넣은 문장 하나에만 붙인다: 시작이 그 문장 구간(앞 1.5초 여유)에 들고 시작이 가장 가까운 문장
    lines = talk["utterances"]
    def best(u):  # 바쁜 기기에서는 첫 중간 결과가 늦어 at이 말 끝 뒤로 밀리기도 한다
        c = [i for i, l in enumerate(lines) if t0 + l["start_s"] * 1000 - 2000 <= u["at"] - offset <= t0 + l["end_s"] * 1000 + 2000]
        return min(c, key=lambda i: abs(u["at"] - offset - t0 - lines[i]["start_s"] * 1000)) if c else None
    owner = {u["seq"]: best(u) for u in items}
    rows = []
    for i, line in enumerate(lines):
        hit = [u for u in items if owner[u["seq"]] == i]
        who = next(k for k, v in VOICE.items() if v == line["who"])
        rows.append({"text": line["text"], "who": who, "row": 0 if line["channel"] == "L" else 1, "seq": [u["seq"] for u in hit],
                     "zone": [z.get(u["seq"]) for u in hit], "got": [next((k for k, v in ids.items() if v == u.get("participantId")), None) for u in hit]})
    zr = [(r["row"], zz) for r in rows for zz in r["zone"]]
    sr = [(r["who"], g) for r in rows for g in r["got"]]
    zone = {"right": sum(a == b for a, b in zr), "wrong": sum(b is not None and a != b for a, b in zr), "unknown": sum(b is None for _, b in zr)}
    spk = {"right": sum(a == b for a, b in sr), "wrong": sum(b is not None and a != b for a, b in sr), "unknown": sum(b is None for _, b in sr)}
    with open(OUT / "speakers.tsv", "w") as f:
        f.write("넣은 문장\t넣은 사람\t줄\t순번\t받은 구역\t받은 사람\n")
        for r in rows: f.write(f"{r['text']}\t{r['who']}\t{r['row']}\t{r['seq']}\t{r['zone']}\t{r['got']}\n")
    (OUT / "uploaded.json").write_text(json.dumps(items, ensure_ascii=False, indent=1))
    (OUT / "capture-log.json").write_text(json.dumps(cap.capture_log, ensure_ascii=False, indent=1))
    base = baseline(talk)
    bs = {"right": sum(a == b for a, b, _ in base), "wrong": sum(b is not None and a != b for a, b, _ in base), "unknown": sum(b is None for _, b, _ in base)}
    note("result", zone=zone, speaker=spk, baseline=bs, baseline_rows=base)
    covered = sum(1 for r in rows if r["seq"])
    check("넣은 문장의 90% 이상에 받아 적은 발화가 하나 이상 붙음(맞힘 수를 셀 바탕)", covered >= len(rows) * 0.9, covered=covered, lines=len(rows))
    check("발화마다 좌석 구역이 맞음(틀림 0)", zr and zone["wrong"] == 0 and zone["right"] >= len(zr) * 0.9, **zone)
    # 서버 임베더가 이 합성 목소리들을 가르는 만큼(차를 거치지 않은 기준)에 견준다. 넣는 목소리는 Yuna 하나의 음높이만 바꾼 것이라
    # 서버도 가르지 못하는(기준이 모름인) 문장이 있다. 차의 틀림은 그런 문장에서만 허용하고, 맞힘은 기준의 절반 이상이어야 한다
    wrong_known = [r["text"] for r, b in zip(rows, base) for g in r["got"] if g is not None and g != r["who"] and b[1] is not None]
    check("발화에 말한 사람이 붙음(서버가 가르는 문장에서는 틀림 0, 맞힘은 차를 거치지 않은 서버 기준의 절반 이상)",
          sr and not wrong_known and spk["right"] * len(lines) >= bs["right"] * len(sr) * 0.5, car=spk, baseline=bs, wrong_where_server_knows=wrong_known)
    # 3. 화면: 방금 받아 적은 말에 이름이 붙고, '누구?'면 주차 중에 고칠 수 있다
    adb("shell", "am", "start", "--user", "10", "-n", f"{PKG}/.MainActivity"); time.sleep(3)
    ui = texts(); shot("03-heard-names"); note("ui", texts=ui)
    named = [t for t in ui if re.match(r"\d\d:\d\d · (아빠|엄마|서준|하은|누구\?) · ", t)]
    check("받아 적은 말 줄에 말한 사람 이름(또는 누구?)이 보임", named, lines=named)
    fixed = None
    unknown = [t for t in ui if " · 누구? · " in t]
    if unknown:  # 모름인 줄마다 이름 단추가 모두 있다(그 구역 사람이 앞). 화면 위쪽의 첫 '누구?' 줄의 '엄마'를 누른다
        fixed = re.sub(r" · 누구\? · ", " · 엄마 · ", unknown[0], count=1)
        for _ in range(3):  # 경유지 카드가 사라지며 줄이 밀리면 누름이 빗나간다. 바뀔 때까지 다시
            tap_text("엄마", last=False); time.sleep(2); ui = texts(); note("ui", texts=ui)
            if fixed in ui: break
        check("모름인 말은 주차 중에 사람을 골라 고칠 수 있음", fixed in ui, line=fixed)
    else:
        note("fix.skip", why="이번 화면의 두 줄에 '누구?'가 없어 고치기 단계는 건너뜀")
    tap_switch(); time.sleep(3)
    (OUT / "results.json").write_text(json.dumps({"code": code, "rows": rows, "zone": zone, "speaker": spk, "log": e2e.log}, ensure_ascii=False, indent=1))
    fails = [e["name"] for e in e2e.log if e["step"] == "check" and not e["ok"]]
    print("실패:", fails if fails else "없음")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[3]) if len(sys.argv) > 3 else 12)
