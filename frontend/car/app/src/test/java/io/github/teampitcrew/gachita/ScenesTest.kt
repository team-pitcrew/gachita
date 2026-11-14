package io.github.teampitcrew.gachita

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/** 차 안 장면 후보(T144): Scenes.kt가 서버(scenes.js)와 같은 입력에 같은 후보를 내는지. */
class ScenesTest {
    // 서버 시험(backend/api/scene-vectors.test.js)이 만든 파일. 규칙을 한쪽만 고치면 여기서 걸린다.
    private val cases = JSONObject(File("../../../backend/api/scene-vectors.json").readText()).getJSONArray("cases").objects()

    private fun JSONArray.objects() = (0 until length()).map(::getJSONObject)
    private fun JSONObject.long(k: String) = if (has(k)) getLong(k) else null
    private fun JSONObject.double(k: String) = if (has(k)) getDouble(k) else null
    private fun JSONObject.text(k: String) = if (has(k) && !isNull(k)) getString(k) else null

    @Test fun sameCandidatesAsServer() {
        assertEquals(6, cases.size)
        for (c in cases) {
            val lines = c.getJSONArray("lines").objects().map {
                SceneLine(it.getLong("seq"), it.getLong("at"), it.text("seatArea") ?: it.text("profileId"), it.double("lat"), it.double("lng"))
            }
            val moments = c.getJSONArray("moments").objects().mapIndexed { k, m -> Moment("m$k", m.getLong("at"), m.long("from"), m.long("to")) }
            val want = c.getJSONArray("expected").objects().map {
                listOf(it.getLong("at"), it.getLong("from"), it.getLong("to"), it.getString("why"), it.getInt("score"),
                    it.getJSONArray("lines").let { a -> (0 until a.length()).map(a::getLong) }, it.double("lat"), it.double("lng"))
            }
            val got = suggestScenes(lines, moments).map { listOf(it.at, it.from, it.to, it.why, it.score, it.lines.map(SceneLine::seq), it.lat, it.lng) }
            assertEquals(c.getString("name"), want, got)
        }
    }

    @Test fun sameCuesAsServer() {
        // 서버 시험(backend/api/cue-vectors.test.js)이 만든 파일.
        val cues = JSONObject(File("../../../backend/api/cue-vectors.json").readText()).getJSONArray("cases").objects()
        assertEquals(6, cues.size)
        for (c in cues) {
            val lines = c.getJSONArray("lines").objects().map {
                CueLine(it.getLong("seq"), it.getLong("at"), it.getString("text"), it.text("displayText") ?: it.text("asrText") ?: it.getString("text"), it.long("endAt"))
            }
            val want = c.getJSONArray("expected").objects().map { CueTiming(it.getLong("seq"), it.getDouble("start"), it.getDouble("end"), it.getString("text")) }
            assertEquals(c.getString("name"), want, cuesOf(lines, c.getLong("startAt"), c.getDouble("seconds")))
        }
    }
}

