package io.github.teampitcrew.gachita

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class CaptureTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun mono(c: Chunk, i: Int) = (c.mono[2 * i].toInt() and 0xff) or (c.mono[2 * i + 1].toInt() shl 8)

    @Test fun 좌우를_더해_모노로_넘치면_자름() {
        val c = downmix(shortArrayOf(100, 23, -5, 0, 30000, 10000, -30000, -10000), 8)
        assertEquals(8, c.mono.size) // 4프레임 × 2바이트
        assertEquals(listOf(123, -5, 32767, -32768), (0 until 4).map { mono(c, it).toShort().toInt() })
        assertFalse(c.allZero)
    }

    @Test fun 모두_0이면_0인_조각() {
        assertTrue(downmix(ShortArray(CHUNK_FRAMES * 2), CHUNK_FRAMES * 2).allZero)
        assertFalse(downmix(ShortArray(CHUNK_FRAMES * 2).also { it[3199] = 1 }, CHUNK_FRAMES * 2).allZero) // 오른쪽 채널 끝 하나만 있어도
    }

    @Test fun 첫_중간_결과에서_열고_최종에서_닫음() {
        val a = Assembler()
        a.partial(10_000, 5_000)
        a.partial(10_400, 5_400) // 두 번째 중간 결과는 시작을 바꾸지 않음
        val d = a.final(" 마트에서 우유랑 간식 사자 ", 12_000, 7_000)!!
        assertEquals(Draft(9_000, 12_000, "마트에서 우유랑 간식 사자", 4_000, 7_000), d)
        val e = a.final("응 다음 휴게소 가자", 20_000, 15_000)!! // 중간 결과 없이 최종이 바로 와도 새로 연다
        assertEquals(19_000, e.startedAt); assertEquals(14_000, e.audioFromMs)
    }

    @Test fun 빈_최종은_버리고_원음_구간은_0_아래로_가지_않음() {
        val a = Assembler()
        a.partial(1_000, 300)
        assertNull(a.final("  ", 1_500, 800))
        assertEquals(0, a.final("네", 2_000, 500)!!.audioFromMs)
    }

    @Test fun 막힘_silenced_0이_1초_읽기_멈춤() {
        val b = Blockage(0)
        assertNull(b.reason(1_000))
        repeat(ZERO_CHUNKS - 1) { b.chunk(true, 1_000L + it * 100) }
        assertNull(b.reason(1_900)) // 0.9초는 아직
        b.chunk(true, 2_000)
        assertEquals("zeros", b.reason(2_000))
        b.chunk(false, 2_100) // 0이 아닌 조각이 오면 풀림
        assertNull(b.reason(2_100))
        assertEquals("stall", b.reason(2_100 + STALL_MS)) // read()가 2초 돌아오지 않음
        b.chunk(false, 5_000)
        b.silenced = true
        assertEquals("silenced", b.reason(5_000))
        b.silenced = false
        assertNull(b.reason(5_000))
    }

    private fun d(n: Int) = Draft(1_000L * n, 1_000L * n + 500, "말 $n", 100L * n, 100L * n + 50)

    @Test fun 보관함_순번과_다시_켜면_이어짐() {
        val dir = tmp.root
        val o = Outbox(dir, "ABC123")
        assertEquals(1, o.add(d(1), null).seq)
        assertEquals(2, o.add(d(2), Fix(37.5, 127.0, 2_400)).seq)
        val again = Outbox(dir, "ABC123")
        assertEquals(2, again.size)
        assertEquals(listOf("말 1", "말 2"), again.recent(5).map { it.text })
        assertEquals(37.5, again.recent(1)[0].lat!!, 0.0)
        assertEquals(3, again.add(d(3), null).seq)
        assertEquals(1, Outbox(dir, "XYZ999").add(d(1), null).seq) // 여행마다 1부터
    }

    @Test fun 위치는_발화_끝에서_30초_안의_것만() {
        val o = Outbox(tmp.root, "ABC123")
        assertNull(o.add(d(100), Fix(37.5, 127.0, 100_500 - FIX_MS - 1)).lat)
        assertEquals(127.0, o.add(d(101), Fix(37.5, 127.0, 101_500 - FIX_MS)).lng!!, 0.0)
    }

    /** 서버(POST /utterances)처럼 lastSeq를 돌려주는 가짜. 받은 묶음을 남긴다. */
    private class Fake(var lastSeq: (List<JSONObject>) -> Long) : Uplink {
        val sent = mutableListOf<List<JSONObject>>()
        override fun send(device: String, items: JSONArray): Long {
            assertEquals("dev-1", device)
            val l = List(items.length()) { items.getJSONObject(it) }
            sent += l
            return lastSeq(l)
        }
    }

    @Test fun 받은_데_뒤만_보내고_일부만_받아도_이어서_보냄() {
        val dir = tmp.root
        val o = Outbox(dir, "ABC123")
        repeat(5) { o.add(d(it + 1), Fix(37.5, 127.0, 1_000L * (it + 1))) }
        val up = Fake { 3 } // 서버가 3까지만 받음
        o.flush(up, "dev-1", max = 4)
        assertEquals(listOf(1L, 2, 3, 4), up.sent[0].map { it.getLong("seq") })
        assertEquals(3, o.acked); assertEquals(2, o.pending)
        up.lastSeq = { it.last().getLong("seq") }
        o.flush(up, "dev-1")
        assertEquals(listOf(4L, 5), up.sent[1].map { it.getLong("seq") })
        assertEquals(0, o.pending)
        assertEquals(5, Outbox(dir, "ABC123").acked) // 받은 데까지도 다시 켜면 남음
        o.flush(Fake { error("보낼 것이 없으면 부르지 않음") }, "dev-1")
    }

    @Test fun 올리는_칸은_서버_계약과_같음() {
        val o = Outbox(tmp.root, "ABC123")
        o.add(d(1), Fix(37.5, 127.0, 1_000)); o.add(d(2), null)
        val up = Fake { 2 }
        o.flush(up, "dev-1")
        val (a, b) = up.sent[0]
        assertEquals(setOf("seq", "at", "text", "generation", "lat", "lng"), a.keys().asSequence().toSet())
        assertEquals(1_000L, a.getLong("at")); assertEquals("말 1", a.getString("text")); assertEquals(1, a.getInt("generation"))
        assertEquals(setOf("seq", "at", "text", "generation"), b.keys().asSequence().toSet()) // 위치를 모르면 둘 다 뺀다
    }

    @Test fun 못_보내면_보관함에_남고_다음에_다시_보냄() {
        val o = Outbox(tmp.root, "ABC123")
        o.add(d(1), null)
        assertTrue(runCatching { o.flush(Fake { throw ApiError(403, "동의하지 않은 탑승자가 있어 올릴 수 없음") }, "dev-1") }.isFailure)
        assertEquals(0, o.acked); assertEquals(1, o.pending)
        o.flush(Fake { 1 }, "dev-1")
        assertEquals(0, o.pending)
    }

    @Test fun 서버가_준_순번이_작으면_내리고_그_뒤를_다시_보냄() { // DB를 백업에서 되살린 경우(ADR-0014 2절)
        val o = Outbox(tmp.root, "ABC123")
        repeat(4) { o.add(d(it + 1), null) }
        o.flush(Fake { 4 }, "dev-1")
        o.add(d(5), null)
        o.flush(Fake { 2 }, "dev-1") // 5를 보냈는데 서버는 2까지만 안다
        assertEquals(2, o.acked)
        val up = Fake { 5 }
        o.flush(up, "dev-1")
        assertEquals(listOf(3L, 4, 5), up.sent[0].map { it.getLong("seq") })
    }

    @Test fun 동의_세대가_오르면_옛_발화의_글을_지우고_순번과_세대만_보냄() {
        val dir = tmp.root
        val o = Outbox(dir, "ABC123")
        o.add(d(1), Fix(37.5, 127.0, 1_000)); o.add(d(2), null)
        o.flush(Fake { 1 }, "dev-1")
        assertFalse(o.see(1))
        assertTrue(o.see(3)) // 동의 철회
        assertEquals(0, o.size); assertTrue(o.recent(5).isEmpty())
        assertFalse(java.io.File(dir, "utterances-ABC123.jsonl").readText().contains("말 ")) // 파일에서도 지워짐
        val later = System.currentTimeMillis() + 1_000 // 세대가 오른 것을 안 뒤에 시작한 말
        assertEquals(3, o.add(Draft(later, later + 500, "말 3", 0, 0), null).generation) // 새 발화는 새 세대
        val up = Fake { 3 }
        o.flush(up, "dev-1")
        assertEquals(setOf("seq", "generation"), up.sent[0][0].keys().asSequence().toSet())
        assertEquals(1, up.sent[0][0].getInt("generation"))
        assertEquals("말 3", up.sent[0][1].getString("text"))
        val again = Outbox(dir, "ABC123") // 다시 켜도 세대와 지운 것이 남음
        assertEquals(3, again.generation); assertEquals(1, again.size); assertEquals(3, again.acked)
    }

    @Test fun 세대가_오른_것을_알기_전에_시작한_말은_앞_세대로_글_없이() { // 폰에서 끄고 10초 안에 다시 켜 기록이 이어진 경우
        val o = Outbox(tmp.root, "ABC123")
        o.see(2)
        val u = o.add(Draft(System.currentTimeMillis() - 5_000, System.currentTimeMillis(), "철회 사이에 한 말", 0, 0), Fix(37.5, 127.0, System.currentTimeMillis()))
        assertEquals(1, u.generation); assertEquals("", u.text); assertNull(u.lat)
        assertEquals(setOf("seq", "generation"), u.wire(2).keys().asSequence().toSet())
    }

    @Test fun 서버_세대가_내려가면_따르고_넘는_세대로_보내지_않음() { // DB를 백업에서 되살린 경우
        val o = Outbox(tmp.root, "ABC123")
        o.see(3)
        val later = System.currentTimeMillis() + 1_000
        val u = o.add(Draft(later, later + 500, "말", 0, 0), null)
        assertFalse(o.see(2))
        assertEquals(2, o.generation)
        assertEquals(2, u.wire(2).getInt("generation")); assertEquals("말", u.wire(2).getString("text"))
    }

    @Test fun 올리는_글은_다듬고_500자에서_이모지를_가르지_않음() {
        val long = "가".repeat(499) + "😀" + "끝"
        val w = Utterance(1, "T", 0, 0, " $long ", 0, 0, 1).wire(1).getString("text")
        assertEquals(499, w.length); assertFalse(w.last().isHighSurrogate())
        assertEquals("바다", Utterance(1, "T", 0, 0, " 바다 ", 0, 0, 1).wire(1).getString("text"))
        assertEquals(" $long ", Utterance.parse(Utterance(1, "T", 0, 0, " $long ", 0, 0, 1).json().toString()).text) // 차 안 사본은 그대로
    }

    @Test fun 쓰다_끊긴_줄은_건너뛰고_다음_줄을_붙여_쓰지_않음() {
        val dir = tmp.root
        Outbox(dir, "ABC123").add(d(1), null)
        java.io.File(dir, "utterances-ABC123.jsonl").appendText("{\"seq\":2,\"trip\":\"ABC") // 쓰는 중에 꺼짐
        val o = Outbox(dir, "ABC123")
        assertEquals(1, o.size)
        assertEquals(2, o.add(d(2), null).seq)
        assertEquals(listOf(1L, 2), Outbox(dir, "ABC123").recent(5).map { it.seq })
    }

    @Test fun 발화_JSON_왕복() {
        val u = Utterance(7, "ABC123", 1_000, 2_000, "바다는 왜 짜?", 300, 1_300, 2, 37.5, 127.0, 1)
        assertEquals(u, Utterance.parse(u.json().toString()))
        val bare = Utterance(8, "ABC123", 1_000, 2_000, "응", 300, 1_300, 1)
        assertEquals(bare, Utterance.parse(bare.json().toString()))
        assertFalse(bare.json().has("gear"))
        assertFalse(u.wire(2).has("seatZone")) // 구역은 차에만
    }
}
