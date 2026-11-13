package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import javax.crypto.KeyGenerator

/** 단위 테스트의 키. 앱은 Android Keystore 키를 쓴다(Seal.keystore). */
val TEST_SEAL = Seal(KeyGenerator.getInstance("AES").apply { init(256) }.generateKey())

class VaultTest {
    @get:Rule val tmp = TemporaryFolder()

    private val day = 24L * 60 * 60 * 1000
    private fun d(n: Int) = Draft(1_000L * n, 1_000L * n + 500, "마트에서 우유랑 간식 사자 $n", 0, 0)

    @Test fun 봉투는_열리고_매번_다르며_다른_키나_고친_줄은_안_열림() {
        val a = TEST_SEAL.line("바다는 왜 짜?")
        assertEquals("바다는 왜 짜?", TEST_SEAL.unline(a))
        assertNotEquals(a, TEST_SEAL.line("바다는 왜 짜?")) // IV가 매번 다름
        val other = Seal(KeyGenerator.getInstance("AES").apply { init(256) }.generateKey())
        assertTrue(runCatching { other.unline(a) }.isFailure)
        assertTrue(runCatching { TEST_SEAL.unline(a.dropLast(4)) }.isFailure) // 쓰다 끊긴 줄
    }

    @Test fun 보관함과_상태_파일과_할_일에_평문이_없음() {
        val dir = tmp.root
        val o = Outbox(dir, "ABC234", TEST_SEAL)
        o.see(1, 1_794_500_000_000)
        o.add(d(1), Fix(37.51, 127.02, 1_000))
        o.flush({ _, _ -> 1 }, "dev-1")
        Todos(dir, "ABC234", TEST_SEAL).add("마트", "마트에서 우유랑 간식 사자")
        for (f in dir.listFiles()!!) {
            val text = f.readText()
            for (plain in listOf("마트", "우유", "37.51", "\"seq\"", "acked", "createdAt", "1794500000000")) assertFalse("${f.name}에 $plain", plain in text)
        }
        assertEquals(3, dir.listFiles()!!.size) // utterances-.jsonl, .acked, todos-.json
        val again = Outbox(dir, "ABC234", TEST_SEAL) // 다시 켜면 풀어서 이어 읽음
        assertEquals("마트에서 우유랑 간식 사자 1", again.recent(1)[0].text); assertEquals(1, again.acked)
        assertEquals(1_794_500_000_000, Outbox.createdAtOf(dir, "ABC234", TEST_SEAL))
        assertEquals("마트", Todos(dir, "ABC234", TEST_SEAL).items[0].place)
    }

    @Test fun 키가_바뀌면_옛_보관함은_읽지_못하고_새로_시작() {
        val dir = tmp.root
        Outbox(dir, "ABC234", TEST_SEAL).add(d(1), null)
        val other = Seal(KeyGenerator.getInstance("AES").apply { init(256) }.generateKey())
        assertEquals(0, Outbox(dir, "ABC234", other).size)
        assertTrue(Todos(dir, "NONE22", other).items.isEmpty())
    }

    @Test fun 만든_뒤_48시간이_지난_여행의_파일만_지움() {
        val dir = tmp.root
        val now = 10 * day
        Outbox(dir, "OLD234", TEST_SEAL).also { it.see(1, now - 2 * day - 1) }.add(d(1), null) // 48시간 넘음
        Todos(dir, "OLD234", TEST_SEAL).add("마트", "마트에서 사자")
        Outbox(dir, "NEW234", TEST_SEAL).also { it.see(1, now - 2 * day + 60_000) }.add(d(1), null) // 아직
        File(dir, "todos-ORPHAN.json").apply { writeText("x"); setLastModified(now - 3 * day) } // 만든 시각을 모르면 파일 시각
        File(dir, "todos-FRESH2.json").apply { writeText("x"); setLastModified(now - day) }
        File(dir, "keep.txt").writeText("우리 파일이 아님")
        assertEquals(setOf("OLD234", "ORPHAN"), sweep(dir, TEST_SEAL, now).toSet())
        assertEquals(setOf("utterances-NEW234.jsonl", "utterances-NEW234.acked", "todos-FRESH2.json", "keep.txt"), dir.list()!!.toSet())
        assertNull(Outbox.createdAtOf(dir, "OLD234", TEST_SEAL))
    }

    @Test fun 서버가_모르는_여행은_그_여행_파일만_지움() {
        val dir = tmp.root
        Outbox(dir, "ABC234", TEST_SEAL).add(d(1), null)
        Todos(dir, "ABC234", TEST_SEAL).add("마트", "마트에서 사자")
        Outbox(dir, "XYZ567", TEST_SEAL).add(d(1), null)
        dropTrip(dir, "ABC234")
        assertEquals(setOf("utterances-XYZ567.jsonl"), dir.list()!!.toSet())
    }

    @Test fun 참가자가_서버에서_지운_글은_차에서도_지움() {
        val o = Outbox(tmp.root, "ABC234", TEST_SEAL)
        repeat(4) { o.add(d(it + 1), null) }
        o.flush({ _, _ -> 3 }, "dev-1") // 서버는 3까지 받음
        assertTrue(o.prune(setOf(1, 3))) // 2는 서버에서 지워짐. 4는 아직 안 받았으니 그대로
        assertEquals(listOf(1L, 3, 4), o.recent(5).map { it.seq })
        assertFalse(o.prune(setOf(1, 3)))
        assertEquals(listOf(1L, 3, 4), Outbox(tmp.root, "ABC234", TEST_SEAL).recent(5).map { it.seq }) // 파일에서도
    }
}
