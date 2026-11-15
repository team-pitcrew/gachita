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
        assertNull("디지털 무음뿐이면 값을 내지 않음", embed(FloatArray(160_000)))
        // 디지털 무음이 섞여도 같은 값(에뮬레이터 주입의 앞뒤·사이, 등록 때 원음 자리에 채운 무음). 서버 시험과 같은 신호
        val voice = cases.take(3).flatMap { pcmSamples(pcm(it)).asList() }.toFloatArray()
        val padded = FloatArray(voice.size + 32_000)
        voice.copyInto(padded, 8_000, 0, 48_000); voice.copyInto(padded, 8_000 + 48_000 + 16_000, 48_000)
        assertTrue(similarity(embed(padded)!!, embed(voice)!!) > 0.99)
        assertEquals(1.0, similarity(vector(cases[0]), vector(cases[0])), 1e-12)
    }

    private fun prints(g: Int, vararg who: Pair<String, DoubleArray>, embedder: String = EMBEDDER, rule: Boolean = false, assign: String? = null) = JSONObject().put("generation", g).put("embedder", embedder)
        .apply { if (rule) put("floor", 0.6).put("margin", 0.06); assign?.let { put("assign", it) } }
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

    @Test fun `끊겨도 보관 시간 안의 사본으로 대조하고 보내기 실패는 대조를 막지 않는다`() {
        val low = vector(cases[0])
        val vp = VoicePrints(tmp.root, "ABC123", TEST_SEAL, now = 1_000)
        val down = { throw java.io.IOException("끊김") }
        assertTrue("사본이 없으면 대조를 미룸", runCatching { vp.refresh(1_000, 1, down) }.exceptionOrNull() is java.io.IOException)
        assertTrue(vp.refresh(1_000, 1) { prints(1, "dad" to low) })
        var asked = 0
        assertFalse("보관 시간 안에는 서버에 묻지 않음", vp.refresh(2_000, 1) { asked++; prints(1) }); assertEquals(0, asked)
        vp.fetchedAt = 0 // 다시 받으라는 표시(탑승자가 바뀜) 뒤 끊김: 가진 사본으로 계속
        assertFalse(vp.refresh(3_000, 1, down)); assertEquals("dad", vp.match(low, listOf("dad")).who)
        assertTrue("서버의 거절은 그대로 던짐", runCatching { vp.refresh(3_000, 1) { throw ApiError(403, "동의 대기") } }.exceptionOrNull() is ApiError)
        assertTrue("보관 시간이 지나면 끊긴 동안에는 대조하지 않음", runCatching { vp.refresh(1_000 + PRINTS_KEEP_MS, 1, down) }.isFailure); assertEquals(0, vp.size)

        // 한 차례: 고친 화자 보내기가 실패해도 차 안 대조와 화자 올리기 시도는 그대로 한다
        val ran = mutableListOf<String>()
        val failed = speakerRound(match = { ran += "match" }, fixes = { ran += "fixes"; throw java.io.IOException("끊김") }, send = { ran += "send" })
        assertEquals(listOf("match", "fixes", "send"), ran); assertTrue(failed is java.io.IOException)
        assertNull(speakerRound({}, {}, {}))
    }

    @Test fun `철회하거나 여행이 지워지면 사본을 바로 버리고 늦은 응답으로 되살리지 않는다`() {
        val low = vector(cases[0])
        val file = File(tmp.root, "voiceprints-ABC123.json")

        // 끊긴 상태에서 이 차로 철회: 서버의 세대를 받지 못해도 바로 지우고, 앞서 시작한 조회의 응답은 저장하지 않는다
        val vp = VoicePrints(tmp.root, "ABC123", TEST_SEAL)
        vp.put(prints(1, "dad" to low)); assertTrue(file.exists())
        vp.drop()
        assertFalse(file.exists()); assertNull(vp.match(low, listOf("dad")).who)
        assertFalse(vp.put(prints(1, "dad" to low))); assertFalse(vp.refresh(System.currentTimeMillis(), 1) { prints(1, "dad" to low) })
        assertFalse(file.exists()); assertEquals(0, vp.size)
        assertEquals("다시 동의한 뒤에는 새로 받는다", 1, VoicePrints(tmp.root, "ABC123", TEST_SEAL).also { it.put(prints(2, "dad" to low)) }.size)
        dropTrip(tmp.root, "ABC123")

        // 조회 응답이 늦는 사이 여행이 지워짐(404 → 사본 버림 + dropTrip): 응답이 와도 파일을 만들지 않는다
        val late = VoicePrints(tmp.root, "ABC123", TEST_SEAL)
        assertFalse(late.refresh(System.currentTimeMillis(), 1) { late.drop(); dropTrip(tmp.root, "ABC123"); prints(1, "dad" to low) })
        assertFalse(file.exists()); assertEquals(0, late.size)
        assertTrue(tmp.root.listFiles().orEmpty().none { it.name.startsWith("voiceprints-") })
    }

    @Test fun `조회를 기다리는 사이 폰에서 철회하면 옛 세대의 응답을 저장하지 않는다`() {
        val low = vector(cases[0])
        val file = File(tmp.root, "voiceprints-ABC123.json")
        val vp = VoicePrints(tmp.root, "ABC123", TEST_SEAL)
        vp.see(1)
        // 세대 1의 응답을 기다리는 동안 여행 조회가 철회(세대 2)를 확인한다. 그 뒤에 도착한 세대 1 응답에는 철회한 사람의 값이 들어 있다
        assertFalse(vp.refresh(1_000, 1) { vp.see(2); prints(1, "dad" to low) })
        assertEquals(0, vp.size); assertFalse(file.exists()); assertNull(vp.match(low, listOf("dad")).who)
        // 값이 있던 사본도 같다: 철회로 지운 뒤 옛 응답이 되살리지 못한다
        assertTrue(vp.put(prints(2, "mom" to low))); vp.fetchedAt = 0
        assertFalse(vp.refresh(2_000, 2) { vp.see(3); prints(2, "mom" to low) })
        assertEquals(0, vp.size); assertFalse(file.exists())
        // 새 세대의 응답은 받는다
        assertTrue(vp.refresh(3_000, 3) { prints(3, "dad" to low) }); assertEquals("dad", vp.match(low, listOf("dad")).who)
    }

    @Test fun `여백 규칙으로 말한 사람을 정한다(서버가 늘 정하기를 끈 경우)`() {
        val (low, mid, high, low2) = cases.map(::vector)
        val vp = VoicePrints(tmp.root, "ABC123", TEST_SEAL)
        vp.put(prints(1, "dad" to low, "kid" to high, rule = true, assign = "margin"))
        val all = listOf("dad", "kid")
        assertEquals("dad", vp.identify(low2, all, null).who) // 0.995 대 −0.16: 뚜렷이 앞섬
        assertEquals("dad", vp.identify(low2, all, listOf("dad")).who)
        assertNull("가장 비슷한 사람이 발화의 줄과 다른 줄이면 붙이지 않음", vp.identify(low2, all, listOf("kid")).who)
        assertNull("바닥(0.6)에 못 미침", vp.identify(mid, all, null).who) // kid 0.50

        // 두 사람이 모두 가깝다: 절대 기준으로는 붙였겠지만(1.0 ≥ 0.9) 두 번째와의 차가 0.005라 붙이지 않는다
        vp.put(prints(1, "dad" to low, "uncle" to low2, rule = true, assign = "margin"))
        assertNull(vp.identify(low, listOf("dad", "uncle"), null).who)
        assertEquals("dad", vp.match(low, listOf("dad", "uncle")).who)

        // 후보가 한 명이면 견줄 사람이 없으니 절대 기준(0.9)
        assertEquals("dad", vp.identify(low2, listOf("dad"), null).who)
        assertNull(vp.identify(mid, listOf("dad"), null).who)
        assertNull("등록값이 없는 후보뿐", vp.identify(low, listOf("mom"), null).who)

        // 옛 서버(floor·margin 없음): 전처럼 줄에서 먼저, 없으면 모두에서 절대 기준
        vp.put(prints(1, "dad" to low, "kid" to high))
        assertEquals("dad", vp.identify(low2, all, listOf("kid")).who)
        vp.put(prints(1, "dad" to low, "uncle" to low2))
        assertEquals("dad", vp.identify(low, listOf("dad", "uncle"), null).who)
    }

    @Test fun `등록한 사람이 있으면 늘 누군가로 정하고 근거를 남긴다(미확인 0퍼센트)`() {
        val (low, mid, high, low2) = cases.map(::vector)
        val vp = VoicePrints(tmp.root, "ABC123", TEST_SEAL)
        assertFalse(vp.assignsAlways) // 받은 값이 없으면 꺼져 있다
        vp.put(prints(1, "dad" to low, "kid" to high, "uncle" to low2, rule = true))
        assertTrue(vp.assignsAlways)
        val all = listOf("dad", "kid", "uncle")
        assertEquals(Pair("kid", "margin"), vp.identify(high, all, null).let { it.who to it.basis }) // 뚜렷이 앞섬
        // 여백을 넘지 못함(dad 1.0, uncle 0.995): 그래도 가장 가까운 사람으로
        assertEquals(Pair("dad", "nearest"), vp.identify(low, all, null).let { it.who to it.basis })
        // 줄을 알면 그 줄 안에서 가장 가까운 사람(전체에서는 dad가 더 가깝다)
        assertEquals(Pair("uncle", "nearest"), vp.identify(low, all, listOf("uncle", "kid")).let { it.who to it.basis })
        // 바닥에 못 미쳐도(kid 0.50) 정한다
        assertEquals(Pair("kid", "nearest"), vp.identify(mid, all, null).let { it.who to it.basis })
        // 그 줄에 등록한 사람이 없으면 모두에서
        assertEquals("kid", vp.identify(high, all, listOf("mom")).who)
        // 등록한 사람이 아무도 없으면 정하지 않는다
        assertNull(vp.identify(low, listOf("mom"), null).who)

        // 값을 못 낸 짧은 말: 같은 줄에서 시각이 가장 가까운 말의 사람, 그 줄에 없으면 줄과 무관하게
        fun utt(seq: Long, at: Long, zone: Int?) = Utterance(seq, "ABC123", at, at + 400, "네", 0, 400, 1, seatZone = zone)
        val known = listOf(utt(1, 1_000, 0) to "dad", utt(2, 5_000, 1) to "kid", utt(3, 9_000, 0) to "uncle")
        assertEquals("uncle", inherit(utt(4, 8_000, 0), known))
        assertEquals("kid", inherit(utt(4, 8_000, 1), known))
        assertEquals("uncle", inherit(utt(4, 8_000, null), known)) // 줄을 모르면 가장 가까운 말
        assertNull(inherit(utt(4, 8_000, 0), emptyList()))

        // 근거는 다시 켜도 남는다
        val sp = Speakers(tmp.root, "ABC123", TEST_SEAL)
        sp.set(1, Speaker("dad", 0.7, sent = false, basis = "nearest"))
        assertEquals("nearest", Speakers(tmp.root, "ABC123", TEST_SEAL)[1]!!.basis)
    }
}
