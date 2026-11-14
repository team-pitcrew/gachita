package io.github.teampitcrew.gachita

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** 차 안 화자 대조(ADR-0023): 임베더가 서버(voice.js)와 같은 값을 내는지, 대조 값 사본의 보관·삭제·대조 규칙. */
class VoiceTest {
    @get:Rule val tmp = TemporaryFolder()

    // 서버 시험(backend/api/voice-vectors.test.js)과 같은 파일. 임베더를 한쪽만 고치면 여기서 걸린다.
    private val fixture = JSONObject(File("../../../backend/api/voice-vectors.json").readText())
    private val cases = fixture.getJSONArray("cases").let { a -> (0 until a.length()).map(a::getJSONObject) }
    private fun vector(c: JSONObject) = c.getJSONArray("vector").let { v -> DoubleArray(v.length()) { v.getDouble(it) } }

    /** 파일의 signal 식 그대로: 정수 연산만으로 만든 톱니파 + 선형 합동 잡음을 16비트 LE PCM으로. */
    private fun pcm(c: JSONObject): ByteArray {
        val n = c.getInt("n"); val period = c.getInt("period"); val amp = c.getInt("amp"); val noise = c.getInt("noise")
        var x = c.getInt("seed")
        return ByteArray(n * 2).also { out ->
            for (i in 0 until n) {
                x = x * 1103515245 + 12345
                val v = (if (period != 0) (i % period) * 2 * amp / period - amp else 0) + ((x ushr 16) % (2 * noise + 1) - noise)
                out[2 * i] = v.toByte(); out[2 * i + 1] = (v shr 8).toByte()
            }
        }
    }

    @Test fun `임베더가 서버와 같은 값을 낸다`() {
        assertEquals(EMBEDDER, fixture.getString("embedder"))
        assertEquals(VOICE_DIMS, fixture.getInt("dims"))
        assertTrue(cases.size >= 6)
        for (c in cases) assertArrayEquals(c.getString("name"), vector(c), embed(pcmSamples(pcm(c)))!!, fixture.getDouble("tolerance"))
        assertNull("한 프레임보다 짧으면 값을 내지 않음", embed(FloatArray(400)))
        assertEquals(1.0, similarity(vector(cases[0]), vector(cases[0])), 1e-12)
    }

    private fun prints(g: Int, vararg who: Pair<String, DoubleArray>, embedder: String = EMBEDDER) = JSONObject().put("generation", g).put("embedder", embedder)
        .put("dims", VOICE_DIMS).put("threshold", 0.9).put("items", org.json.JSONArray(who.map { (id, v) -> JSONObject().put("participantId", id).put("vector", org.json.JSONArray(v)).put("seconds", 7) }))

    @Test fun `받은 대조 값으로 서버와 같은 기준으로 가린다`() {
        val (low, mid, high, low2) = cases.map(::vector)
        val vp = VoicePrints(tmp.root, "ABC123", TEST_SEAL)
        assertNull("받은 값이 없으면 모름", vp.match(low, listOf("dad")).who)
        vp.put(prints(1, "dad" to low, "kid" to high))
        assertEquals("dad", vp.match(low2, listOf("dad", "kid")).who)
        assertEquals("kid", vp.match(high, listOf("dad", "kid")).who)
        assertNull("기준 아래는 모름", vp.match(mid, listOf("dad", "kid")).who)
        assertNull("후보(그 줄의 동의한 사람)에 없으면 모름", vp.match(low2, listOf("kid")).who)
        assertNull("값이 없는 후보", vp.match(low2, listOf("mom")).who)
    }

    @Test fun `사본은 암호화해 두고 세대가 바뀌거나 여행이 지워지면 지운다`() {
        val low = vector(cases[0])
        val file = File(tmp.root, "voiceprints-ABC123.json")
        VoicePrints(tmp.root, "ABC123", TEST_SEAL).put(prints(2, "dad" to low))
        assertFalse("평문으로 두지 않음", file.readText().let { "dad" in it || "vector" in it })
        val again = VoicePrints(tmp.root, "ABC123", TEST_SEAL) // 앱을 다시 켜도(끊겨 있어도) 이어 쓴다
        assertEquals("dad", again.match(low, listOf("dad")).who)
        again.see(2); assertTrue(file.exists())
        again.see(3) // 누군가 동의를 철회함
        assertFalse(file.exists()); assertNull(again.match(low, listOf("dad")).who); assertTrue(again.stale(System.currentTimeMillis()))

        again.put(prints(3, "dad" to low)); again.put(prints(3)) // 서버에서 사라진 값은 차에도 남지 않는다
        assertEquals(0, again.size); assertEquals(0, VoicePrints(tmp.root, "ABC123", TEST_SEAL).size)
        again.put(prints(3, "dad" to low, embedder = "other-2")) // 다른 수식의 값과는 견주지 않는다
        assertNull(again.match(low, listOf("dad")).who)

        // 받은 사본은 3시간 30분 쓰고, 그 뒤에는 지우고 다시 받는다(다시 켰을 때도)
        again.put(prints(3, "dad" to low), now = 1_000)
        assertFalse(again.stale(1_000 + PRINTS_KEEP_MS - 1)); assertTrue(again.stale(1_000 + PRINTS_KEEP_MS))
        again.fetchedAt = 0; again.expire(2_000) // 다시 받으라는 표시만으로는 지우지 않는다(끊겼을 때 쓰게)
        assertEquals("dad", again.match(low, listOf("dad")).who)
        // 앱을 다시 켠 뒤에도 보관 시간 안이면 남는다(끊겨서 다시 받지 못해도 그 사본으로 대조). 대조할 말이 없어도 시간이 지나면 지운다
        val reopened = VoicePrints(tmp.root, "ABC123", TEST_SEAL, now = 2_000)
        reopened.expire(1_000 + PRINTS_KEEP_MS - 1)
        assertEquals("dad", reopened.match(low, listOf("dad")).who); assertTrue(file.exists()); assertFalse(reopened.stale(1_000 + PRINTS_KEEP_MS - 1))
        assertEquals(1, VoicePrints(tmp.root, "ABC123", TEST_SEAL, now = 1_000 + PRINTS_KEEP_MS - 1).size)
        VoicePrints(tmp.root, "ABC123", TEST_SEAL, now = 2_000).let { idle ->
            idle.expire(1_000 + PRINTS_KEEP_MS); assertEquals(0, idle.size); assertFalse(file.exists())
        }
        again.put(prints(3, "dad" to low), now = 1_000)
        assertEquals(0, VoicePrints(tmp.root, "ABC123", TEST_SEAL, now = 1_000 + PRINTS_KEEP_MS).size); assertFalse(file.exists())

        again.put(prints(3, "dad" to low))
        dropTrip(tmp.root, "ABC123"); assertFalse(file.exists())
    }

    @Test fun `찾은 사람은 발화와 함께 올리고 값 등록은 소리 없이 값만 보낸다`() {
        val box = Outbox(tmp.root, "ABC123", TEST_SEAL)
        repeat(3) { box.add(Draft(1000L + it, 2000L + it, "말 $it", 0, 900), null, 0) }
        box.flush({ _, items -> items.length().toLong() }, "car")
        val sp = Speakers(tmp.root, "ABC123", TEST_SEAL)
        sp.set(1, Speaker("dad", 0.97, sent = false)); sp.set(2, Speaker(null, 0.4)); sp.set(3, Speaker("kid", 1.0, byPerson = true, sent = false))
        assertEquals(setOf(1L), sp.unsentMatches().keys) // 모름과 사람이 고친 것은 이 길로 가지 않는다
        val (seq, item) = box.wires(sp.unsentMatches()).single()
        assertEquals(1L, seq)
        assertEquals(listOf("dad", "device-voice", 0.97, "말 0"), listOf(item.getString("participantId"), item.getString("speakerMethod"), item.getDouble("speakerConfidence"), item.getString("text")))
        sp.set(1, sp[1]!!.copy(sent = true))
        assertTrue(Speakers(tmp.root, "ABC123", TEST_SEAL).unsentMatches().isEmpty())

        val body = voiceValue(vector(cases[0]), 9.8)
        assertEquals(listOf(EMBEDDER, VOICE_DIMS, 9.8), listOf(body.getString("embedder"), body.getJSONArray("vector").length(), body.getDouble("seconds")))
    }

    @Test fun `밀린 화자는 묶음으로 나눠 올리고 성공한 묶음만 남긴 것으로 적는다`() {
        val box = Outbox(tmp.root, "ABC123", TEST_SEAL)
        val n = SPEAKER_BATCH * 2 + 30 + 1
        repeat(n) { box.add(Draft(1000L + it, 2000L + it, "말 $it", 0, 900), null, 0) }
        box.flush({ _, _ -> (n - 1).toLong() }, "car", max = n) // 마지막 하나는 서버가 아직 받지 않음
        val sp = Speakers(tmp.root, "ABC123", TEST_SEAL)
        for (seq in 1L..n) sp.set(seq, Speaker("dad", 0.95, sent = false))
        assertEquals(n, sp.unsentMatches().size)

        val sent = mutableListOf<Int>()
        runCatching { sendSpeakers(box, sp, { true }) { items -> if (sent.size == 1) throw java.io.IOException("끊김"); sent += items.length() } }
        assertEquals(listOf(SPEAKER_BATCH), sent) // 둘째 묶음에서 끊김
        assertEquals(n - SPEAKER_BATCH, sp.unsentMatches().size) // 성공한 첫 묶음만 남긴 것으로
        assertEquals((SPEAKER_BATCH + 1).toLong(), sp.unsentMatches().keys.min())

        sent.clear(); var ok = true
        sendSpeakers(box, sp, { ok }) { items -> sent += items.length(); ok = false } // 그사이 동의를 끄면 남은 묶음은 보내지 않는다
        assertEquals(listOf(SPEAKER_BATCH), sent)

        sent.clear()
        sendSpeakers(box, sp, { true }) { items -> sent += items.length() }
        assertEquals(listOf(30), sent)
        assertEquals(setOf(n.toLong()), sp.unsentMatches().keys) // 서버가 받지 않은 발화의 것은 받은 뒤에 보낸다
        assertTrue(sent.all { it <= 500 })
    }
}
