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
