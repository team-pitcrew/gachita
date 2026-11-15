"""시연 여행의 대화 기록을 교정본(최종본)으로 저장한다(T159, 오너 11/15 '이런 정보는 고친 최종본으로 저장이 되게 해').

차가 받아 적은 줄은 원문(text)으로 남기고, 시연 원천의 교정본(DEMO_INPUTS/timeline.json의 talks_seat: 말한 사람·글)을
공식 고치기 API로 최종본에 남긴다 — 글은 PATCH /trips/{code}/captions/{device}/{seq}(edited_text, 동의한 참가자),
말한 사람은 PATCH /trips/{code}/utterances/{device}/{seq}(speaker_by_hand, 그 기기로 올린 참가자 = 차 운전석).
화면(차 C44·폰 P44)과 쇼츠 자막은 최종본(edited_text → asr_text → text)을 쓴다. 쇼츠를 만들기 전에 저장해야 한다 —
자막·화자가 바뀌면 서버가 옛 원본으로 만든 영상을 취소한다(원본이 바뀐 영상).

잇기: 차 기기의 줄을 시각 틈(20초 넘음)으로 묶어 넣은 대화 순서에 맞추고, 묶음 안에서는 순서를 지키는 정렬(DP)로
교정본 줄을 원문 줄에 나눠 준다(글자 2-그램 유사도 합이 가장 크게). 차는 두 사람의 말을 한 줄로 받아 적기도 해서 한 줄에
여러 교정본 줄이 갈 수 있고, 그때 말한 사람은 글자가 많은 쪽이다. 교정본 줄이 하나도 가지 않은 원문 줄은 건드리지 않는다.

  python3 frontend/car/final_transcript.py   # 정렬 스스로 검사
"""
import re

GAP_MS = 20_000


def bigrams(s):
    s = re.sub(r"[^0-9A-Za-z가-힣]", "", s)
    return [s[i:i + 2] for i in range(len(s) - 1)] or ([s] if s else [])


def sim(a, b):
    """글자 2-그램 다이스 계수(0~1)."""
    x, y = bigrams(a), bigrams(b)
    if not x or not y:
        return 0.0
    pool, hit = list(y), 0
    for g in x:
        if g in pool:
            pool.remove(g); hit += 1
    return 2 * hit / (len(x) + len(y))


def align(raw, lines):
    """raw(원문 글)마다 받는 교정본 줄 번호 목록. 순서를 지키고 교정본 줄을 모두 쓴다. ponytail: O(n·m²) — 묶음이 수십 줄이라 충분하다."""
    n, m, neg = len(raw), len(lines), float("-inf")
    best = [[neg] * (m + 1) for _ in range(n + 1)]
    back = [[0] * (m + 1) for _ in range(n + 1)]
    best[0][0] = 0.0
    for i in range(1, n + 1):
        for j in range(m + 1):
            for k in range(j + 1):  # 원문 i-1이 교정본 [k, j)를 받는다(빈 묶음도 됨)
                if best[i - 1][k] == neg:
                    continue
                score = best[i - 1][k] + (sim(raw[i - 1], " ".join(lines[k:j])) if j > k else 0.0)
                if score > best[i][j]:
                    best[i][j], back[i][j] = score, k
    out, j = [], m
    for i in range(n, 0, -1):
        k = back[i][j]; out.append(list(range(k, j))); j = k
    return out[::-1]


def plan(utterances, participants, talks, device):
    """utterances: GET /transcript의 utterances, participants: 여행 참가자, talks: [[{who, text}, …] 넣은 순서대로], device: 차 기기.
    돌려주는 것: [(줄, 최종본 글, 말한 사람 participantId 또는 None)] — 교정본 줄이 간 줄만."""
    names = {p["name"]: p["id"] for p in participants}
    rows = sorted((u for u in utterances if u["device"] == device and u["text"]), key=lambda u: u["at"])
    groups, last = [], None
    for u in rows:
        if last is None or u["at"] - last > GAP_MS:
            groups.append([])
        groups[-1].append(u); last = u.get("endAt") or u["at"]
    if len(groups) != len(talks):
        raise ValueError(f"받아 적은 묶음 {len(groups)}개가 넣은 대화 {len(talks)}개와 맞지 않음(틈 기준 {GAP_MS} ms)")
    out = []
    for group, lines in zip(groups, talks):
        for u, idx in zip(group, align([u["text"] for u in group], [l["text"] for l in lines])):
            if not idx:
                continue
            weight = {}
            for i in idx:
                weight[lines[i].get("who")] = weight.get(lines[i].get("who"), 0) + len(lines[i]["text"])
            who = max(weight, key=weight.get)
            out.append((u, " ".join(lines[i]["text"] for i in idx), names.get(who) if who else None))
    return out


if __name__ == "__main__":
    # 스스로 검사: 차가 두 말을 한 줄로 받아 적고, 한 줄은 엉뚱하게 받아 적은 경우(시연 pass2의 실제 모양을 줄인 것)
    lines = [{"who": "정민", "text": "자, 민준님 도착했거든요."}, {"who": "지환", "text": "어, 민준이 잘 봐. 지금 빨리 생각해."},
             {"who": "정민", "text": "어떤 거 하실래요?"}, {"who": "민준", "text": "못 나가는 게 편한데."}, {"who": "지환", "text": "주행 중에는 못 나가니까."}]
    raw = ["그래서 민주님 도착했거든요 민준이 잘 봐 지금 빨리 생각해", "제가 알았지 우리 빨리 아빠가 왜 죽었던 거 하실래요? 맛있었어요", "사실 못 나가는게 비행기인데 주행 중에 못 나가니까 잘"]
    assert align(raw, [l["text"] for l in lines]) == [[0, 1], [2], [3, 4]], align(raw, [l["text"] for l in lines])
    people = [{"id": "p1", "name": "정민"}, {"id": "p2", "name": "지환"}, {"id": "p3", "name": "민준"}]
    utt = [{"device": "car", "seq": i + 1, "at": 1000 + i * 5000, "text": t} for i, t in enumerate(raw)] + [{"device": "phone", "seq": 1, "at": 2000, "text": "다른 기기"}]
    got = plan(utt, people, [lines], "car")
    assert [(u["seq"], text, who) for u, text, who in got] == [(1, "자, 민준님 도착했거든요. 어, 민준이 잘 봐. 지금 빨리 생각해.", "p2"), (2, "어떤 거 하실래요?", "p1"),
                                                               (3, "못 나가는 게 편한데. 주행 중에는 못 나가니까.", "p2")], got
    try:
        plan(utt + [{"device": "car", "seq": 9, "at": 99_000, "text": "다음 묶음"}], people, [lines], "car"); raise AssertionError("묶음 수가 다르면 멈춰야 함")
    except ValueError:
        pass
    print("final_transcript: 스스로 검사 통과")
