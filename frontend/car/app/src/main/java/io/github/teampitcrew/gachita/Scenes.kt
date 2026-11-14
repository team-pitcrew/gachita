package io.github.teampitcrew.gachita

// 장면 후보(T43)를 차 안에서 고른다(T144). backend/api/scenes.js의 suggest와 같은 규칙·같은 상수이고,
// 두 구현은 backend/api/scene-vectors.json 한 파일로 맞춘다(ScenesTest.kt). 한쪽만 고치면 시험이 걸린다.
// 서버 GET /scene-suggestions는 폰이 쓰므로 같은 규칙으로 남는다.

/** 받아 적은 발화 한 줄. who는 좌석 구역, 없으면 화자 대조로 붙은 프로필(둘 다 없으면 null — 말한 사람으로 세지 않음). */
data class SceneLine(val seq: Long, val at: Long, val who: String?, val lat: Double? = null, val lng: Double? = null)
data class SceneCandidate(val at: Long, val from: Long, val to: Long, val why: String, val score: Int, val lines: List<SceneLine>, val lat: Double?, val lng: Double?)

private const val SCENE_WINDOW_MS = 30_000L // 발화를 세는 창
private const val SCENE_MIN_LINES = 4
private const val SCENE_MIN_SPAN_MS = 15_000L
private const val SCENE_MAX_ITEMS = 5
private const val SCENE_MAX_LINES = 30

/**
 * 시각 순 발화(글이 빈 줄 제외)에서 각 발화로 시작하는 30초 창을 발화 수 + 2×(말한 사람 수 − 1)로 매기고,
 * 이미 남긴 장면(구간 없으면 앞 20초~뒤 10초)과도 서로도 겹치지 않는 창을 점수 순으로 5개까지. 돌려줄 때는 시각 순.
 * 두 손가락으로 훑어 O(n log n).
 */
fun suggestScenes(lines: List<SceneLine>, moments: List<Moment>): List<SceneCandidate> {
    class Win(val i: Int, val j: Int, val from: Long, val to: Long, val speakers: Int, val score: Int)
    val taken = moments.map { (it.from ?: (it.at - 20_000)) to (it.to ?: (it.at + 10_000)) }
    val said = HashMap<String, Int>()
    fun count(u: SceneLine, d: Int) {
        val w = u.who ?: return
        val n = (said[w] ?: 0) + d
        if (n != 0) said[w] = n else said.remove(w)
    }
    val windows = ArrayList<Win>()
    var j = 0
    for (i in lines.indices) {
        if (i > 0) count(lines[i - 1], -1)
        while (j < lines.size && lines[j].at < lines[i].at + SCENE_WINDOW_MS) count(lines[j++], 1)
        if (j - i < SCENE_MIN_LINES) continue
        val from = lines[i].at - 1000
        windows += Win(i, j, from, maxOf(lines[j - 1].at + 4000, from + SCENE_MIN_SPAN_MS), said.size, j - i + 2 * (said.size - 1))
    }
    val picked = ArrayList<Win>()
    for (c in windows.sortedWith(compareByDescending<Win> { it.score }.thenBy { it.from })) { // 안정 정렬: JS sort와 같은 순서
        if (picked.size == SCENE_MAX_ITEMS) break
        if (taken.none { c.from < it.second && it.first < c.to } && picked.none { c.from < it.to && it.from < c.to }) picked += c
    }
    return picked.sortedBy { it.from }.map { w ->
        val inside = lines.subList(w.i, w.j)
        val here = inside.firstOrNull { it.lat != null }
        val why = "${SCENE_WINDOW_MS / 1000}초에 말이 ${w.j - w.i}번" + if (w.speakers > 1) ", ${w.speakers}명이 말함" else ""
        SceneCandidate(lines[w.i].at, w.from, w.to, why, w.score, inside.take(SCENE_MAX_LINES), here?.lat, here?.lng)
    }
}

/** 자막 큐 입력 한 줄. text는 Pleos 원문(길이 어림에 씀), shown은 보일 글(수동 수정 → 재전사 → 원문). endAt은 실제 끝 시각(있으면). */
data class CueLine(val seq: Long, val at: Long, val text: String, val shown: String = text, val endAt: Long? = null)
data class CueTiming(val seq: Long, val start: Double, val end: Double, val text: String)

/**
 * 숏폼 자막 큐를 차 안에서(T144). 서버 scenes.js의 cues와 같은 규칙이고 두 구현은 backend/api/cue-vectors.json으로 맞춘다(ScenesTest.kt).
 * 클립 구간(startAt부터 seconds초) 안의 발화(시각 순)를 클립 처음부터의 초로. 끝 시각이 있으면 그것(겹침 보존), 없으면 원문 코드포인트 수 × 0.15초
 * (1~6초)를 다음 발화에서 자르되 1초는 남긴다. 클립보다 먼저 시작했어도 실제 구간이 겹치면 넣는다(끝 시각은 10초까지라 10초 앞부터 본다).
 */
fun cuesOf(lines: List<CueLine>, startAt: Long, seconds: Double): List<CueTiming> {
    val end = startAt + seconds * 1000
    var lo = 0
    var hi = lines.size
    while (lo < hi) { val mid = (lo + hi) ushr 1; if (lines[mid].at < startAt - 10_000) lo = mid + 1 else hi = mid }
    val inside = ArrayList<CueLine>()
    for (k in lo until lines.size) {
        val u = lines[k]
        if (u.at >= end) break
        if (u.at >= startAt || (u.endAt ?: Long.MIN_VALUE) > startAt) inside += u
    }
    fun sec(ms: Double) = Math.round(ms) / 1000.0
    return inside.mapIndexed { i, u ->
        val guess = u.at + minOf(6000, maxOf(1000, u.text.codePointCount(0, u.text.length) * 150)).toDouble()
        val stop = if (u.endAt != null) minOf(end, u.endAt.toDouble())
            else minOf(end, maxOf(u.at + 1000.0, minOf(guess, inside.getOrNull(i + 1)?.at?.toDouble() ?: end)))
        CueTiming(u.seq, sec(maxOf(0.0, (u.at - startAt).toDouble())), sec(stop - startAt), u.shown)
    }
}
