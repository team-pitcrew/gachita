package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.json.JSONObject

/** 둘째 값(강한 화자 값, StrongVoice.kt): 서버에서 받은 값의 보관과 판정 규칙, 올리는 본문. 모델 자체(JNI)는 단위 시험이 닿지 않아 에뮬레이터에서 본다. */
class StrongVoiceTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun wide(vararg x: Float) = FloatArray(STRONG_DIMS).also { x.copyInto(it) }
    private val dad = wide(1f, 0f, 0f); private val mom = wide(0.9f, 0.4f, 0f); private val kid = wide(0f, 1f, 0f); private val sis = wide(0f, 0.9f, 0.4f)
    private val one = org.json.JSONArray(DoubleArray(VOICE_DIMS) { 1.0 })
    private val front = listOf("p1", "p2"); private val rear = listOf("p3", "p4", "p5")
    private val all = front + rear // p5는 등록하지 않은 손님

    private fun prints(vararg who: Pair<String, FloatArray?>, name: String? = STRONG_EMBEDDER) = JSONObject().put("generation", 1).put("embedder", EMBEDDER).put("dims", VOICE_DIMS)
        .put("threshold", 0.9).put("floor", 0.6).put("margin", 0.06).apply { name?.let { put("strongEmbedder", it) } }
        .put("items", org.json.JSONArray(who.map { (id, s) -> JSONObject().put("participantId", id).put("vector", one).put("seconds", 7).apply { s?.let { put("strong", org.json.JSONArray(it.map(Float::toDouble))) } } }))

    @Test fun `등록자 모두가 둘째 값을 가졌을 때 줄 안에서 가장 가까운 사람으로 정한다`() {
        val vp = VoicePrints(tmp.root, "ABC123", TEST_SEAL)
        assertNull("받은 값이 없으면 1차 임베더로", vp.identifyStrong(dad, all, null)); assertFalse(vp.hasStrong)
        vp.put(prints("p1" to dad, "p2" to mom, "p3" to kid, "p4" to null))
        assertTrue(vp.hasStrong)
        assertNull("등록자 가운데 둘째 값이 없는 사람이 있으면 1차 임베더로", vp.identifyStrong(dad, all, front))
        assertEquals("그 사람이 후보가 아니면(동의하지 않음) 남은 등록자끼리", "p1", vp.identifyStrong(dad, listOf("p1", "p2", "p3"), null)!!.who)
        vp.put(prints("p1" to dad, "p2" to mom, "p3" to kid, "p4" to sis))
        val near = wide(0.95f, 0.3f, 0f) // dad 0.954, mom 0.999: 둘 다 가깝지만 늘 가장 가까운 사람으로(미확인 0%)
        assertEquals(Pair("p2", "strong"), vp.identifyStrong(near, all, front)!!.let { it.who to it.basis })
        assertEquals("줄을 알면 그 줄에서: 전체에서는 엄마가 더 가깝다", "p3", vp.identifyStrong(near, all, rear)!!.who)
        assertEquals("줄을 모르면 모두에서", "p2", vp.identifyStrong(near, all, null)!!.who)
        assertEquals("그 줄에 등록자가 없으면 모두에서", "p2", vp.identifyStrong(near, all, listOf("p5"))!!.who)
        assertNull("등록자가 없으면 정하지 않는다", vp.identifyStrong(kid, listOf("p5"), null))
        // 앱을 다시 켜도 사본에서 되살린다. 철회로 사본을 지우면 둘째 값도 사라진다
        val again = VoicePrints(tmp.root, "ABC123", TEST_SEAL)
        assertEquals("p4", again.identifyStrong(sis, all, null)!!.who)
        again.see(2); assertFalse(again.hasStrong); assertNull(again.identifyStrong(sis, all, null))
    }

    @Test fun `모델 이름이 다르거나 길이가 다른 둘째 값은 쓰지 않는다`() {
        val vp = VoicePrints(tmp.root, "ABC123", TEST_SEAL)
        vp.put(prints("p1" to dad, "p2" to mom, name = "wespeaker-resnet34-v2")); assertFalse(vp.hasStrong)
        vp.put(prints("p1" to dad, "p2" to mom, name = null)); assertFalse("옛 서버(이름을 주지 않음)", vp.hasStrong)
        vp.put(prints("p1" to dad, "p2" to floatArrayOf(1f, 0f)))
        assertNull("길이가 다른 값은 없는 것으로 본다", vp.identifyStrong(dad, front, null))
        assertEquals(2, vp.size) // 1차 값은 그대로라 1차 규칙으로 정한다
    }

    @Test fun `둘째 값을 올리는 본문`() {
        val o = strongValue(dad, 14.0)
        assertEquals(STRONG_EMBEDDER, o.getString("embedder")); assertEquals(STRONG_DIMS, o.getJSONArray("vector").length()); assertEquals(14.0, o.getDouble("seconds"), 0.0)
        assertEquals("서버가 받는 범위로", 20.0, strongValue(dad, 31.0).getDouble("seconds"), 0.0)
    }

    @Test fun `디지털 무음을 뺀다`() {
        val x = FloatArray(1600) { if (it in 320 until 800) 0.1f else 0f } // 10 ms 묶음 열 개 가운데 셋만 소리
        assertEquals(480, withoutSilence(x).size)
        assertEquals(0, withoutSilence(FloatArray(500)).size)
        assertEquals(170, withoutSilence(FloatArray(170) { 0.1f }).size) // 끝의 짧은 묶음도 남긴다
        assertEquals(1.0, cosine(dad, dad), 1e-9); assertEquals(0.0, cosine(dad, kid), 1e-9)
    }
}
