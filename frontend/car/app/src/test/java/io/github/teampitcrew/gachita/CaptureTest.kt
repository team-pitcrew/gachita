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

    @Test fun 합치기_전_채널별_에너지를_셈() {
        val c = downmix(shortArrayOf(100, 0, -100, 0, 0, 10), 6)
        assertEquals(20_000.0, c.left, 0.0); assertEquals(100.0, c.right, 0.0)
    }

    @Test fun 좌석_구역은_두_채널_크기_차로_가르고_작으면_모름() {
        assertEquals(0, zoneOf(1e8, 1e2)) // 왼쪽 = 앞줄(에뮬레이터 기준)
        assertEquals(1, zoneOf(1e2, 1e8))
        assertNull(zoneOf(1e6, 0.5e6)) // 3 dB 차
        assertNull(zoneOf(0.0, 0.0))
    }

    @Test fun 발화_구간의_묶음만_더해_구역을_냄() {
        val lv = Levels(size = 50)
        repeat(30) { lv.add(it.toLong(), 1e6, 1.0) } // 0~3초 앞줄
        repeat(30) { lv.add(30L + it, 1.0, 1e6) } // 3~6초 뒷줄
        assertEquals(0, lv.zone(500, 2_500))
        assertEquals(1, lv.zone(3_500, 5_900))
        assertNull(lv.zone(2_000, 4_000)) // 반반이면 모름
        assertNull(lv.zone(0, 900)) // 50묶음(5초)보다 오래된 구간은 없음
        assertNull(lv.zone(7_000, 8_000)) // 아직 없는 구간
    }

    @Test fun 말한_사람은_덧붙여_쌓고_사람이_고친_것을_대조가_덮지_않음() {
        val sp = Speakers(tmp.root, "ABC123", TEST_SEAL)
        sp.set(1, Speaker("p1", 0.95)); sp.set(2, Speaker(null, 0.4))
        sp.set(2, Speaker("p2", 1.0, byPerson = true)); sp.set(2, Speaker(null, 0.5))
        val again = Speakers(tmp.root, "ABC123", TEST_SEAL)
        assertEquals(Speaker("p1", 0.95), again[1]); assertEquals(Speaker("p2", 1.0, true), again[2]); assertNull(again[3])
        assertFalse(java.io.File(tmp.root, "speakers-ABC123.jsonl").readText().contains("{")) // 줄마다 Base64 봉투(평문 JSON이 아님)
    }

    @Test fun 짧게_읽힌_조각은_같은_묶음_자리에_더함() {
        val lv = Levels(size = 10)
        repeat(4) { lv.add(0, 1e6, 0.0) } // 같은 번호로 네 번(짧게 읽힘)
        lv.add(1, 0.0, 1e6)
        assertEquals(0, lv.zone(0, 199)) // 4e6 대 1e6 = 6 dB. 덮어쓰면 1e6 대 1e6이라 모름
    }

    @Test fun 대조를_마친_순번과_세대가_오르면_말한_사람을_지움() {
        val sp = Speakers(tmp.root, "ABC123", TEST_SEAL)
        sp.see(1); sp.set(1, Speaker("p1", 0.95)); sp.done(1); sp.done(3)
        val again = Speakers(tmp.root, "ABC123", TEST_SEAL)
        assertEquals(3, again.through); assertEquals("p1", again[1]?.who) // 다시 켜면 그 뒤부터
        again.see(1) // 같은 세대
        assertEquals("p1", again[1]?.who)
        again.see(2) // 동의 철회
        assertNull(again[1]); assertEquals(3, again.through)
        val after = Speakers(tmp.root, "ABC123", TEST_SEAL)
        assertNull(after[1]); assertEquals(3, after.through)
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
        val o = Outbox(dir, "ABC123", TEST_SEAL)
        assertEquals(1, o.add(d(1), null).seq)
        assertEquals(2, o.add(d(2), Fix(37.5, 127.0, 2_400)).seq)
        val again = Outbox(dir, "ABC123", TEST_SEAL)
        assertEquals(2, again.size)
        assertEquals(listOf("말 1", "말 2"), again.recent(5).map { it.text })
        assertEquals(37.5, again.recent(1)[0].lat!!, 0.0)
        assertEquals(3, again.add(d(3), null).seq)
        assertEquals(1, Outbox(dir, "XYZ999", TEST_SEAL).add(d(1), null).seq) // 여행마다 1부터
    }

    @Test fun 위치는_발화_끝에서_30초_안의_것만() {
        val o = Outbox(tmp.root, "ABC123", TEST_SEAL)
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
        val o = Outbox(dir, "ABC123", TEST_SEAL)
        repeat(5) { o.add(d(it + 1), Fix(37.5, 127.0, 1_000L * (it + 1))) }
        val up = Fake { 3 } // 서버가 3까지만 받음
        o.flush(up, "dev-1", max = 4)
        assertEquals(listOf(1L, 2, 3, 4), up.sent[0].map { it.getLong("seq") })
        assertEquals(3, o.acked); assertEquals(2, o.pending)
        up.lastSeq = { it.last().getLong("seq") }
        o.flush(up, "dev-1")
        assertEquals(listOf(4L, 5), up.sent[1].map { it.getLong("seq") })
        assertEquals(0, o.pending)
        assertEquals(5, Outbox(dir, "ABC123", TEST_SEAL).acked) // 받은 데까지도 다시 켜면 남음
        o.flush(Fake { error("보낼 것이 없으면 부르지 않음") }, "dev-1")
    }

    @Test fun 올리는_칸은_서버_계약과_같음() {
        val o = Outbox(tmp.root, "ABC123", TEST_SEAL)
        o.add(d(1), Fix(37.5, 127.0, 1_000)); o.add(d(2), null)
        val up = Fake { 2 }
        o.flush(up, "dev-1")
        val (a, b) = up.sent[0]
        assertEquals(setOf("seq", "at", "text", "generation", "lat", "lng"), a.keys().asSequence().toSet())
        assertEquals(1_000L, a.getLong("at")); assertEquals("말 1", a.getString("text")); assertEquals(1, a.getInt("generation"))
        assertEquals(setOf("seq", "at", "text", "generation"), b.keys().asSequence().toSet()) // 위치를 모르면 둘 다 뺀다
    }

    @Test fun 못_보내면_보관함에_남고_다음에_다시_보냄() {
        val o = Outbox(tmp.root, "ABC123", TEST_SEAL)
        o.add(d(1), null)
        assertTrue(runCatching { o.flush(Fake { throw ApiError(403, "동의하지 않은 탑승자가 있어 올릴 수 없음") }, "dev-1") }.isFailure)
        assertEquals(0, o.acked); assertEquals(1, o.pending)
        o.flush(Fake { 1 }, "dev-1")
        assertEquals(0, o.pending)
    }

    @Test fun 서버가_준_순번이_작으면_내리고_그_뒤를_다시_보냄() { // DB를 백업에서 되살린 경우(ADR-0014 2절)
        val o = Outbox(tmp.root, "ABC123", TEST_SEAL)
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
        val o = Outbox(dir, "ABC123", TEST_SEAL)
        o.add(d(1), Fix(37.5, 127.0, 1_000)); o.add(d(2), null)
        o.flush(Fake { 1 }, "dev-1")
        assertFalse(o.see(1, 0))
        assertTrue(o.see(3, 0)) // 동의 철회
        assertEquals(0, o.size); assertTrue(o.recent(5).isEmpty())
        val later = System.currentTimeMillis() + 1_000 // 세대가 오른 것을 안 뒤에 시작한 말
        assertEquals(3, o.add(Draft(later, later + 500, "말 3", 0, 0), null).generation) // 새 발화는 새 세대
        val up = Fake { 3 }
        o.flush(up, "dev-1")
        assertEquals(setOf("seq", "generation"), up.sent[0][0].keys().asSequence().toSet())
        assertEquals(1, up.sent[0][0].getInt("generation"))
        assertEquals("말 3", up.sent[0][1].getString("text"))
        val again = Outbox(dir, "ABC123", TEST_SEAL) // 다시 켜도 세대와 지운 것이 남음
        assertEquals(3, again.generation); assertEquals(1, again.size); assertEquals(3, again.acked)
    }

    @Test fun 세대가_오른_것을_알기_전에_시작한_말은_앞_세대로_글_없이() { // 폰에서 끄고 10초 안에 다시 켜 기록이 이어진 경우
        val o = Outbox(tmp.root, "ABC123", TEST_SEAL)
        o.see(2, 0)
        val u = o.add(Draft(System.currentTimeMillis() - 5_000, System.currentTimeMillis(), "철회 사이에 한 말", 0, 0), Fix(37.5, 127.0, System.currentTimeMillis()))
        assertEquals(1, u.generation); assertEquals("", u.text); assertNull(u.lat)
        assertEquals(setOf("seq", "generation"), u.wire(2)!!.keys().asSequence().toSet())
    }

    @Test fun 서버_세대가_내려가면_따르고_넘는_세대로_보내지_않음() { // DB를 백업에서 되살린 경우
        val o = Outbox(tmp.root, "ABC123", TEST_SEAL)
        o.see(3, 0)
        val later = System.currentTimeMillis() + 1_000
        val u = o.add(Draft(later, later + 500, "말", 0, 0), null)
        assertFalse(o.see(2, 0))
        assertEquals(2, o.generation)
        assertEquals(2, u.wire(2)!!.getInt("generation")); assertEquals("말", u.wire(2)!!.getString("text"))
    }

    @Test fun 철회로_지운_발화는_세대가_거꾸로_가도_새_발화를_막지_않음() { // 동의 철회 → 서버 DB 되살림(세대 역행) → 새 발화
        val o = Outbox(tmp.root, "ABC123", TEST_SEAL)
        o.add(d(1), null); o.add(d(2), null)
        o.see(2, 0) // 철회: 1·2의 글을 지움
        assertFalse(o.see(1, 0)) // 서버가 세대 1로 되살아남
        val later = System.currentTimeMillis() + 1_000
        o.add(Draft(later, later + 500, "새 말", 0, 0), null)
        val up = Fake { 0 }
        o.flush(up, "dev-1")
        assertEquals(listOf(3L), up.sent[0].map { it.getLong("seq") }) // 앞 세대가 없어 지운 발화는 보내지 않고, 새 발화는 감
        assertEquals("새 말", up.sent[0][0].getString("text"))
        // 세대 3에서 철회한 뒤 세대 2로 되살아나면 지운 발화는 앞 세대(1)로 순번만
        val o2 = Outbox(java.io.File(tmp.root, "b").apply { mkdirs() }, "ABC123", TEST_SEAL)
        o2.see(2, 0); val l2 = System.currentTimeMillis() + 1_000; o2.add(Draft(l2, l2 + 500, "말", 0, 0), null)
        o2.see(3, 0); o2.see(2, 0)
        val up2 = Fake { 1 }
        o2.flush(up2, "dev-1")
        assertEquals(setOf("seq", "generation"), up2.sent[0][0].keys().asSequence().toSet()); assertEquals(1, up2.sent[0][0].getInt("generation"))
    }

    @Test fun 철회를_안_때까지의_순번을_지우고_세대가_오르내려도_그_경계로만() { // 세대 3 → 2(서버 DB 되살림) → 3(철회)
        val dir = tmp.root
        val o = Outbox(dir, "ABC123", TEST_SEAL)
        o.see(3, 0)
        val t = System.currentTimeMillis() + 1_000
        fun say(n: Int) = o.add(Draft(t + n, t + n + 500, "말 $n", 0, 0), null)
        say(1); say(2) // 세대 3
        o.see(2, 0); say(3) // 되살아난 세대 2
        assertTrue(o.see(3, 0)) // 철회: 그때까지의 1~3을 모두 지움(세대로 견주면 1·2가 남았음)
        assertEquals(0, o.size)
        val later = System.currentTimeMillis() + 2_000
        o.add(Draft(later, later + 500, "철회 뒤 말", 0, 0), null) // 순번 4
        val again = Outbox(dir, "ABC123", TEST_SEAL) // 다시 켜도 경계(3)로만 지움: 철회 뒤 말은 남음
        assertEquals(listOf("철회 뒤 말"), again.recent(5).map { it.text })
    }

    @Test fun 지운_발화가_묶음보다_많아도_세대_1로_되살아난_뒤_새_발화가_나감() { // 철회로 120건을 지움 → 서버가 세대 1, lastSeq 0으로 되살아남
        val o = Outbox(tmp.root, "ABC123", TEST_SEAL)
        repeat(120) { o.add(d(it + 1), null) }
        o.see(2, 0); o.see(1, 0)
        val later = System.currentTimeMillis() + 1_000
        repeat(30) { o.add(Draft(later + it, later + it + 500, "새 말 $it", 0, 0), null) }
        val up = Fake { 0 }
        o.flush(up, "dev-1", max = 20)
        o.flush(up, "dev-1", max = 20)
        o.flush(up, "dev-1", max = 20) // 보낼 것이 없으면 부르지 않음
        assertEquals(listOf((121L..140L).toList(), (141L..150L).toList()), up.sent.map { b -> b.map { it.getLong("seq") } })
    }

    @Test fun 철회한_글을_파일에서_못_지웠으면_다음_조회와_다시_켤_때_다시_지움() {
        val dir = tmp.root
        val o = Outbox(dir, "ABC123", TEST_SEAL)
        o.add(d(1), Fix(37.5, 127.0, 1_000))
        val tmpFile = java.io.File(dir, "utterances-ABC123.jsonl.tmp").apply { mkdir() } // 임시 파일 자리에 폴더: 바꾸기가 실패함
        assertTrue(o.see(2, 0))
        val plain = { java.io.File(dir, "utterances-ABC123.jsonl").readLines().map { runCatching { TEST_SEAL.unline(it) }.getOrDefault("") } }
        assertTrue(plain().any { "말 1" in it }) // 아직 파일에 남음
        val later = System.currentTimeMillis() + 1_000
        o.add(Draft(later, later + 500, "새 말", 0, 0), null) // 새 세대 발화가 쌓임
        assertTrue(Outbox(dir, "ABC123", TEST_SEAL).recent(5).none { it.text == "말 1" }) // 다시 켜면 옛 세대 글은 비움
        tmpFile.delete()
        o.see(2, 0) // 다음 조회에서 다시 바꿈
        assertFalse(plain().any { "말 1" in it })
    }

    @Test fun 보낼_것이_없어도_서버_순번을_다시_받아_내려가면_그_뒤를_다시_보냄() { // 서버 DB가 백업에서 되살아남(ADR-0014 2절)
        val o = Outbox(tmp.root, "ABC123", TEST_SEAL)
        repeat(5) { o.add(d(it + 1), null) }
        o.flush(Fake { 5 }, "dev-1")
        o.flush(Fake { error("보낼 것이 없으면 부르지 않음") }, "dev-1")
        val probe = Fake { 3 }
        o.flush(probe, "dev-1", always = true)
        assertEquals(listOf(emptyList<Long>()), probe.sent.map { b -> b.map { it.getLong("seq") } }) // 빈 묶음
        assertEquals(3, o.acked); assertEquals(2, o.pending)
        val up = Fake { 5 }
        o.flush(up, "dev-1")
        assertEquals(listOf(4L, 5), up.sent[0].map { it.getLong("seq") })
    }

    @Test fun 올리는_글은_다듬고_500자에서_이모지를_가르지_않음() {
        val long = "가".repeat(499) + "😀" + "끝"
        val w = Utterance(1, "T", 0, 0, " $long ", 0, 0, 1).wire(1)!!.getString("text")
        assertEquals(499, w.length); assertFalse(w.last().isHighSurrogate())
        assertEquals("바다", Utterance(1, "T", 0, 0, " 바다 ", 0, 0, 1).wire(1)!!.getString("text"))
        assertEquals(" $long ", Utterance.parse(Utterance(1, "T", 0, 0, " $long ", 0, 0, 1).json().toString()).text) // 차 안 사본은 그대로
    }

    @Test fun 쓰다_끊긴_줄은_건너뛰고_다음_줄을_붙여_쓰지_않음() {
        val dir = tmp.root
        Outbox(dir, "ABC123", TEST_SEAL).add(d(1), null)
        java.io.File(dir, "utterances-ABC123.jsonl").appendText(TEST_SEAL.line("{\"seq\":2}").take(20)) // 쓰는 중에 꺼짐
        val o = Outbox(dir, "ABC123", TEST_SEAL)
        assertEquals(1, o.size)
        assertEquals(2, o.add(d(2), null).seq)
        assertEquals(listOf(1L, 2), Outbox(dir, "ABC123", TEST_SEAL).recent(5).map { it.seq })
    }

    @Test fun 발화_JSON_왕복() {
        val u = Utterance(7, "ABC123", 1_000, 2_000, "바다는 왜 짜?", 300, 1_300, 2, 37.5, 127.0, 1)
        assertEquals(u, Utterance.parse(u.json().toString()))
        val bare = Utterance(8, "ABC123", 1_000, 2_000, "응", 300, 1_300, 1)
        assertEquals(bare, Utterance.parse(bare.json().toString()))
        assertFalse(bare.json().has("gear"))
        assertFalse(u.wire(2)!!.has("seatZone")) // 구역은 차에만(서버 seatArea는 좌석 하나, 대조는 row로)
    }
}
