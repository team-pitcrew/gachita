package io.github.teampitcrew.gachita

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/** 여행 마무리·장면 고르기(C22–C32)의 순수 함수. 폰(frontend/web/after-trip.test.mjs)과 같은 규칙. */
class AfterTripTest {
    private fun cand(from: Long, to: Long, score: Int) = SceneCandidate(from + 1000, from, to, "", score, emptyList(), null, null)
    private fun line(key: Long, text: String, person: String? = null, zone: String? = null) = AfterLine(key, key * 1000, text, zone, person)
    private val names = mapOf("dad" to "아빠", "son" to "서준", "kid" to "하은")

    @Test fun topThreeByScoreInTimeOrder() {
        val got = topPicks(listOf(cand(500, 900, 4), cand(100, 400, 9), cand(2000, 2400, 7), cand(1000, 1300, 9), cand(3000, 3300, 2)))
        assertEquals(listOf(100L, 1000L, 2000L), got.map { it.from })
        assertEquals(listOf(1L), topPicks(listOf(cand(5, 9, 1), cand(1, 9, 1)), 1).map { it.from })
        assertEquals(emptyList<Long>(), topPicks(listOf(cand(9, 9, 9))).map { it.from })
    }

    @Test fun clocksAndDurations() {
        assertEquals("00:12:04", afterClock((12 * 60 + 4) * 1000L + 999))
        assertEquals("01:08:24", afterClock(4104_000))
        assertEquals("00:00:00", afterClock(-5000))
        assertEquals("34:12", afterAxis((34 * 60 + 12) * 1000L))
        assertEquals("1:08:24", afterAxis(4104_000))
        assertEquals("00:12:04–00:12:36", afterSpan(724_000, 756_000, 0))
        assertEquals("1시간 8분", afterDuration(4104)); assertEquals("1시간", afterDuration(3600)); assertEquals("8분", afterDuration(480))
        assertEquals("40초", afterDuration(40)); assertEquals("", afterDuration(0))
    }

    @Test fun titleIsTheStrongestLine() {
        val lines = listOf(line(1, "바다 어디 있지", "dad"), line(2, "아빠, 아까부터 바다 보이는데?", "son"), line(3, "어 정말이네 어디 어디 어디 어디 어디 있었지 진짜로 몰랐어", "dad"))
        assertEquals(Triple("아빠, 아까부터 바다 보이는데?", "아빠 “바다 어디 있지”", "son"), pickTitle(lines, names))
        assertEquals(Triple("서준의 한마디", "서준 “와!”", "son"), pickTitle(listOf(line(1, "응", "dad"), line(2, "와!", "son")), names))
        assertEquals("화자를 모르면 그 말 그대로", Triple("와!", "“응”", null), pickTitle(listOf(line(1, "와!"), line(2, "응")), names))
        assertEquals(Triple("함께 나눈 이야기", "", null), pickTitle(listOf(line(1, " ")), names))
        assertEquals("가나…", clipText("가나다라", 3))
    }

    @Test fun barsAndProgress() {
        assertEquals(listOf(0.58f, 1f, 0.58f, 0f), afterBars(listOf(0L, 10, 15, 19, 25, 99), 0, 40, 4).map { Math.round(it * 100) / 100f })
        assertEquals(listOf(0f, 0f, 0f), afterBars(listOf(5L), 10, 10, 3))
        assertEquals(0.55f, phaseProgress(Phase.RENDER, .5f), 1e-6f)
        assertEquals(1f, phaseProgress(Phase.DONE), 0f)
    }

    /** 폰과 같은 추천 장면을 내는지: 폰 벡터(frontend/web/scene-picks-vectors.json, #396)가 있을 때만. */
    @Test fun samePicksAsPhone() {
        val f = File("../../web/scene-picks-vectors.json")
        assumeTrue("폰 벡터는 #396 병합 뒤에 생긴다", f.exists())
        val v = JSONObject(f.readText())
        fun JSONArray.objects() = (0 until length()).map(::getJSONObject)
        val names = v.getJSONArray("participants").objects().associate { it.getString("id") to it.getString("name") }
        val byKey = HashMap<Long, AfterLine>()
        val cands = v.getJSONArray("items").objects().map { o ->
            val ls = o.getJSONArray("lines").objects().map { l ->
                AfterLine(l.getLong("seq"), l.getLong("at"), l.optString("displayText", l.optString("text")), l.optString("seatArea").ifEmpty { null }, l.optString("participantId").ifEmpty { null })
                    .also { byKey[it.key] = it }
            }
            SceneCandidate(o.getLong("at"), o.getLong("from"), o.getLong("to"), o.getString("why"), o.getInt("score"), ls.map { SceneLine(it.key, it.at, it.zone) }, null, null)
        }
        val origin = v.getLong("origin")
        val want = v.getJSONArray("expected").objects().map { listOf(it.getInt("number"), it.getLong("from"), it.getLong("to"), it.getString("time"), it.getString("title"), it.getString("quote"), it.optString("speakerId").ifEmpty { null }) }
        val got = afterPicks(cands, byKey, names).map { listOf(it.number, it.from, it.to, afterSpan(it.from, it.to, origin), it.title, it.quote, it.speakerId) }
        assertEquals(want, got)
    }

    // 리허설 run1: 렌더 뒤 check() 실패(IllegalStateException)가 '서버에 닿지 않아요'로만 보였다
    @Test fun afterErrorShowsTheRealReason() {
        assertEquals("주차 상태를 확인해 주세요", afterError(IllegalStateException("주차 상태를 확인해 주세요")))
        assertEquals("IllegalArgumentException", afterError(IllegalArgumentException()))
        assertEquals("서버에 닿지 않아요(SocketTimeoutException)", afterError(java.net.SocketTimeoutException("read timed out")))
        assertEquals(failureText(ApiError(409, "x")), afterError(ApiError(409, "x")))
    }
}
