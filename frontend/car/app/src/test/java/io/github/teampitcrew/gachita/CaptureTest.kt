package io.github.teampitcrew.gachita

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
        assertEquals(1, o.add(d(1), "P").seq)
        assertEquals(2, o.add(d(2), "D").seq)
        val again = Outbox(dir, "ABC123")
        assertEquals(2, again.size)
        assertEquals(listOf("말 1", "말 2"), again.recent(5).map { it.text })
        assertEquals("D", again.recent(1)[0].gear)
        assertEquals(3, again.add(d(3), null).seq)
        assertEquals(1, Outbox(dir, "XYZ999").add(d(1), "D").seq) // 여행마다 1부터
    }

    @Test fun 받은_데_뒤만_보내고_일부만_받아도_이어서_보냄() {
        val dir = tmp.root
        val o = Outbox(dir, "ABC123")
        repeat(5) { o.add(d(it + 1), "D") }
        val sent = mutableListOf<List<Long>>()
        var serverAck = 0L
        val up = Uplink { trip, device, items ->
            assertEquals("ABC123", trip); assertEquals("dev-1", device)
            sent += items.map { it.seq }
            serverAck = minOf(items.last().seq, 3); serverAck // 서버가 3까지만 받음
        }
        o.flush(up, "dev-1", max = 4)
        assertEquals(listOf(1L, 2, 3, 4), sent[0])
        assertEquals(3, o.acked); assertEquals(2, o.pending)
        serverAck = 0
        o.flush(Uplink { _, _, items -> sent += items.map { it.seq }; items.last().seq }, "dev-1")
        assertEquals(listOf(4L, 5), sent[1])
        assertEquals(0, o.pending)
        assertEquals(5, Outbox(dir, "ABC123").acked) // 받은 데까지도 다시 켜면 남음
        o.flush(Uplink { _, _, _ -> error("보낼 것이 없으면 부르지 않음") }, "dev-1")
    }

    @Test fun 지금_꽂힌_KEEP은_보내지_않고_쌓아_둠() {
        val o = Outbox(tmp.root, "ABC123")
        o.add(d(1), "D")
        o.flush(KEEP, "dev-1")
        assertEquals(0, o.acked); assertEquals(1, o.pending)
    }

    @Test fun 쓰다_끊긴_줄은_건너뛰고_다음_줄을_붙여_쓰지_않음() {
        val dir = tmp.root
        Outbox(dir, "ABC123").add(d(1), "D")
        java.io.File(dir, "utterances-ABC123.jsonl").appendText("{\"seq\":2,\"trip\":\"ABC") // 쓰는 중에 꺼짐
        val o = Outbox(dir, "ABC123")
        assertEquals(1, o.size)
        assertEquals(2, o.add(d(2), "D").seq)
        assertEquals(listOf(1L, 2), Outbox(dir, "ABC123").recent(5).map { it.seq })
    }

    @Test fun 발화_JSON_왕복() {
        val u = Utterance(7, "ABC123", 1_000, 2_000, "바다는 왜 짜?", 300, 1_300, null, 1)
        assertEquals(u, Utterance.parse(u.json().toString()))
        assertTrue(u.json().isNull("gear"))
    }
}
