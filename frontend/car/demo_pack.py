"""시연 팩 채우기(T156): 저장소 밖의 시연 원천(교정 전사·완성 쇼츠·표지)을 디버그 빌드의 assets/demo/에 넣는다.

차 앱(DemoPack.kt)은 디버그 빌드에 assets/demo/manifest.json이 들어 있으면, 여행을 마친 뒤의 화면(대화 기록·추천 장면·생성·콘텐츠 기록)을
서버 대신 이 팩으로 그린다. 팩 내용은 실제 대화와 목소리라 저장소에 넣지 않는다 — app/src/debug/assets/demo/는 .gitignore다.
이 스크립트와 팩 형식만 저장소에 있다. 원천 파일의 자리와 사람 이름·제목은 모두 명세 파일(저장소 밖 JSON)에 적는다.

  python3 frontend/car/demo_pack.py <명세.json>            # app/src/debug/assets/demo/ 에 채움
  python3 frontend/car/demo_pack.py <명세.json> --out <폴더>
  python3 frontend/car/demo_pack.py --clear                # 팩을 지움(팩 없는 빌드로 되돌림)
  python3 frontend/car/demo_pack.py --self-test            # 지어낸 값으로 스스로 검사

명세(예시는 지어낸 값):
  {"title": "주말 나들이", "group": "나들이 모임", "seconds": 1200,
   "started": "2026-01-03T10:00:00+09:00",                # 없으면 앱이 지금 여행을 만든 시각에 맞춘다
   "people": [{"id": "a", "name": "가람", "seat": "ROW_1_LEFT", "character": "glasses", "label": "가람"}, …],
   "utterances": "/밖/전체전사.json",                      # {"utterances": [{"start": 초, "who": label, "text": 글}]} — 여행 전체의 줄
   "talks": "/밖/교정전사.json",                           # 선택. {"clips": {이름: {"source_s": [시작, 끝], "lines": [{"start", "who", "text"}]}}}
                                                          #   교정한 구간: 그 구간(source_s)의 전체 전사 줄은 빼고 이 줄로 바꿔 넣는다
   "route": [{"lat": 37.5, "lng": 127.0, "name": "출발지"}, {"lat": 37.45, "lng": 127.05}, {"lat": 37.4, "lng": 127.1, "name": "도착지"}],
   "scenes": [{"id": "s1", "from": 300, "to": 330, "title": "장면 제목", "quote": "대표 문장", "who": "가람", "at": 312,
               "video": "/밖/쇼츠.mp4", "cover": "/밖/표지.png"}]}
  - who는 people의 label(없으면 name이나 id). 화자를 모르는 줄(who가 없거나 people에 없음)은 팩에 넣지 않고 몇 줄인지 알린다.
  - 장면 구간에 줄이 하나도 없을 때만 대표 문장을 대화 기록에 한 줄로 넣는다(at 초, 없으면 구간 시작).
  - 장면의 지도 위 자리는 구간 가운데 시각을 여행 길이에 비례해 경로 위에 놓는다. 영상 길이는 ffprobe로 재고, 없으면 구간 길이.
"""
import argparse, datetime, json, math, pathlib, re, shutil, subprocess, sys, tempfile

OUT = pathlib.Path(__file__).resolve().parent / "app/src/debug/assets/demo"
SEATS = ("ROW_1_LEFT", "ROW_1_RIGHT", "ROW_2_LEFT", "ROW_2_CENTER", "ROW_2_RIGHT")


def along(route, fraction):
    """경로 길이의 fraction(0~1) 자리의 (위도, 경도)."""
    def dist(a, b):
        return math.hypot(b["lat"] - a["lat"], (b["lng"] - a["lng"]) * math.cos(math.radians(a["lat"])))
    legs = [dist(a, b) for a, b in zip(route, route[1:])]
    left = max(0.0, min(1.0, fraction)) * sum(legs)
    for (a, b), d in zip(zip(route, route[1:]), legs):
        if left <= d and d > 0:
            k = left / d
            return a["lat"] + (b["lat"] - a["lat"]) * k, a["lng"] + (b["lng"] - a["lng"]) * k
        left -= d
    return route[-1]["lat"], route[-1]["lng"]


def video_seconds(path, fallback):
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                             capture_output=True, text=True, timeout=30).stdout.strip()
        return round(float(out), 1)
    except (OSError, ValueError, subprocess.SubprocessError):
        return round(fallback, 1)


def build(spec, out):
    """명세를 읽어 out 폴더에 manifest.json과 영상·표지를 쓴다. 돌려주는 것: (manifest, 뺀 줄 수)."""
    people = spec["people"]
    assert people and len({p["id"] for p in people}) == len(people), "people의 id가 비었거나 겹칩니다"
    for p in people:
        assert p["seat"] in SEATS, f"모르는 자리: {p['seat']}"
        assert re.fullmatch(r"[A-Za-z0-9_-]+", p["id"]), f"id는 영문·숫자만: {p['id']}"
    who = {}
    for p in people:
        for key in (p["id"], p["name"], p.get("label")):
            if key: who[key] = p["id"]
    seconds = float(spec["seconds"])
    route = [{"lat": float(r["lat"]), "lng": float(r["lng"]), **({"name": r["name"]} if r.get("name") else {})} for r in spec["route"]]
    assert len(route) >= 2, "route는 두 점 이상"

    lines, dropped, wave = [], 0, []
    def add(rows):
        nonlocal dropped
        for l in rows:
            text = (l.get("text") or "").strip()
            if not text or l.get("who") not in who or not 0 <= float(l["start"]) <= seconds: dropped += 1; continue
            lines.append({"at": round(float(l["start"]), 2), "who": who[l["who"]], "text": text})
    clips = list(json.loads(pathlib.Path(spec["talks"]).read_text(encoding="utf-8")).get("clips", {}).values()) if spec.get("talks") else []
    fixed = [tuple(map(float, c["source_s"])) for c in clips if c.get("source_s")]  # 교정본이 있는 구간
    if spec.get("utterances"):
        rows = json.loads(pathlib.Path(spec["utterances"]).read_text(encoding="utf-8")).get("utterances", [])
        wave = sorted(round(float(u["start"]), 1) for u in rows if 0 <= float(u["start"]) <= seconds)
        add(u for u in rows if not any(a <= float(u["start"]) < b for a, b in fixed))
    for clip in clips: add(clip.get("lines", []))

    out.mkdir(parents=True, exist_ok=True)
    for old in out.iterdir():
        if old.is_file(): old.unlink()
    scenes = []
    for s in spec["scenes"]:
        sid = s["id"]
        assert re.fullmatch(r"[A-Za-z0-9_-]+", sid), f"장면 id는 영문·숫자만: {sid}"
        start, end = float(s["from"]), float(s["to"])
        assert 0 <= start < end <= seconds, f"장면 {sid}의 구간이 여행 밖이거나 뒤집혔습니다"
        speaker = who.get(s.get("who")) if s.get("who") else None
        assert not s.get("who") or speaker, f"장면 {sid}의 화자가 people에 없습니다"
        video = pathlib.Path(s["video"]); assert video.is_file(), f"영상이 없습니다: {video.name}"
        shutil.copyfile(video, out / f"{sid}.mp4")
        scene = {"id": sid, "from": start, "to": end, "title": s["title"].strip(), "quote": s["quote"].strip(), "video": f"{sid}.mp4",
                 "seconds": video_seconds(video, end - start)}
        if speaker: scene["who"] = speaker
        if s.get("cover"):
            cover = pathlib.Path(s["cover"]); assert cover.is_file(), f"표지가 없습니다: {cover.name}"
            shutil.copyfile(cover, out / f"{sid}{cover.suffix.lower()}"); scene["cover"] = f"{sid}{cover.suffix.lower()}"
        scene["lat"], scene["lng"] = (round(v, 6) for v in along(route, (start + end) / 2 / seconds))
        scenes.append(scene)
        if speaker and not any(start <= l["at"] < end for l in lines):
            lines.append({"at": round(float(s.get("at", start)), 2), "who": speaker, "text": scene["quote"]})
    assert scenes, "scenes가 비었습니다"
    manifest = {"version": 1, "title": spec["title"], "group": spec["group"], "seconds": seconds,
                "people": [{"id": p["id"], "name": p["name"], "seat": p["seat"], "character": p.get("character", "")} for p in people],
                "lines": sorted(lines, key=lambda l: l["at"]), "wave": wave, "route": route, "scenes": sorted(scenes, key=lambda s: s["from"])}
    if spec.get("started"):
        manifest["startedAt"] = int(datetime.datetime.fromisoformat(spec["started"]).timestamp() * 1000)
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    return manifest, dropped


def self_test():
    with tempfile.TemporaryDirectory() as d:
        d = pathlib.Path(d)
        (d / "v.mp4").write_bytes(b"0"); (d / "c.png").write_bytes(b"0")
        (d / "talks.json").write_text(json.dumps({"clips": {"x": {"source_s": [8, 20], "lines": [
            {"start": 10, "who": "가람", "text": "어디로 갈까?"}, {"start": 12, "who": None, "text": "모르는 사람"}, {"start": 14, "who": "나래", "text": "바다 어때?"}]}}}), encoding="utf-8")
        (d / "all.json").write_text(json.dumps({"utterances": [{"start": 2, "who": "나래", "text": "출발!"}, {"start": 11, "who": "가람", "text": "어디로 갈가"},
            {"start": 45, "who": "나래", "text": "바다 어때?"}, {"start": 50, "who": "가람", "text": ""}]}), encoding="utf-8")
        spec = {"title": "주말 나들이", "group": "나들이 모임", "seconds": 100,
                "people": [{"id": "a", "name": "가람", "seat": "ROW_1_LEFT", "character": "glasses"}, {"id": "b", "name": "나래", "seat": "ROW_1_RIGHT"}],
                "talks": str(d / "talks.json"), "utterances": str(d / "all.json"), "route": [{"lat": 37.0, "lng": 127.0, "name": "출발지"}, {"lat": 37.0, "lng": 127.2, "name": "도착지"}],
                "scenes": [{"id": "s1", "from": 40, "to": 60, "title": "바다 가자", "quote": "바다 어때?", "who": "나래", "video": str(d / "v.mp4"), "cover": str(d / "c.png")},
                           {"id": "s2", "from": 70, "to": 90, "title": "도착", "quote": "다 왔다!", "who": "a", "at": 75, "video": str(d / "v.mp4")}]}
        m, dropped = build(spec, d / "out")
        # 교정 구간(8–20초)의 전체 전사 줄은 교정본으로 바뀌고, 화자·글이 빈 줄은 빠지고, 줄이 있는 장면에는 대표 문장을 더 넣지 않는다
        assert dropped == 2 and [(l["at"], l["who"]) for l in m["lines"]] == [(2.0, "b"), (10.0, "a"), (14.0, "b"), (45.0, "b"), (75.0, "a")], m["lines"]
        assert m["wave"] == [2.0, 11.0, 45.0, 50.0]
        assert m["lines"][-1] == {"at": 75.0, "who": "a", "text": "다 왔다!"}
        assert abs(m["scenes"][0]["lng"] - 127.1) < 1e-6 and m["scenes"][0]["seconds"] == 20.0 and m["scenes"][0]["cover"] == "s1.png"
        assert sorted(p.name for p in (d / "out").iterdir()) == ["manifest.json", "s1.mp4", "s1.png", "s2.mp4"]
        assert "startedAt" not in m
    print("demo_pack 스스로 검사 통과")


def main():
    ap = argparse.ArgumentParser(description="시연 팩 채우기(T156)")
    ap.add_argument("spec", nargs="?"); ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--clear", action="store_true"); ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test: return self_test()
    out = pathlib.Path(a.out)
    if a.clear:
        shutil.rmtree(out, ignore_errors=True); print(f"팩을 지웠습니다: {out}"); return
    if not a.spec: ap.error("명세 파일이 필요합니다")
    m, dropped = build(json.loads(pathlib.Path(a.spec).read_text(encoding="utf-8")), out)
    size = sum(f.stat().st_size for f in out.iterdir()) / 1e6
    print(f"팩을 채웠습니다: {out} — 사람 {len(m['people'])}, 줄 {len(m['lines'])}(화자·글이 비어 뺀 줄 {dropped}), 장면 {len(m['scenes'])}, 경로 점 {len(m['route'])}, {size:.1f} MB")
    print("이제 ./gradlew assembleDebug 로 팩이 든 디버그 APK를 만듭니다. 이 폴더는 커밋하지 않습니다(.gitignore).")


if __name__ == "__main__":
    sys.exit(main())
