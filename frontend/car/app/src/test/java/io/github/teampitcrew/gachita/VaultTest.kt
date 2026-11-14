package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertArrayEquals
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

    @Test fun 디버그_시험_기간을_명시했을_때만_지난_여행의_파일을_지움() {
        val dir = tmp.root
        val now = 10 * day
        Outbox(dir, "OLD234", TEST_SEAL).also { it.see(1, now - 2 * day - 1) }.add(d(1), null) // 48시간 넘음
        Todos(dir, "OLD234", TEST_SEAL).add("마트", "마트에서 사자")
        Outbox(dir, "NEW234", TEST_SEAL).also { it.see(1, now - 2 * day + 60_000) }.add(d(1), null) // 아직
        File(dir, "todos-ORPHAN.json").writeText("[{\"id\":1,\"place\":\"마트\"}]") // 만든 시각이 없거나(암호화 전 평문) 열리지 않으면 바로 지움
        File(dir, "keep.txt").writeText("우리 파일이 아님")
        assertEquals(setOf("OLD234", "ORPHAN"), sweep(dir, TEST_SEAL, now, keepMs = 2 * day).toSet())
        assertEquals(setOf("utterances-NEW234.jsonl", "utterances-NEW234.acked", "keep.txt"), dir.list()!!.toSet())
        assertNull(Outbox.createdAtOf(dir, "OLD234", TEST_SEAL))
    }

    @Test fun 기본값은_48시간이_지나도_녹취와_원음이_남고_명시적_철회는_지움() {
        val dir = tmp.root
        val born = day
        val now = 90 * day
        val outbox = Outbox(dir, "OLD234", TEST_SEAL)
        outbox.see(1, born)
        outbox.add(Draft(born, born + 500, "오래된 대화", 0, 0), Fix(37.51, 127.02, born))
        Todos(dir, "OLD234", TEST_SEAL).add("마트", "마트에서 우유 사자")
        val pcm = ByteArray(CHUNK_FRAMES * 2) { (it % 127).toByte() }
        RawWriter(dir, "OLD234", 1, born, TEST_SEAL).use { it.write(pcm) }
        ClipLog(dir, "OLD234").add("saved-scene")
        val files = dir.list()!!.toSet()

        assertFalse(retentionExpired(born, now))
        assertTrue(sweep(dir, TEST_SEAL, now).isEmpty())
        assertEquals(files, dir.list()!!.toSet())
        val restored = Outbox(dir, "OLD234", TEST_SEAL)
        assertEquals("오래된 대화", restored.recent(1).single().text)
        assertEquals("마트", Todos(dir, "OLD234", TEST_SEAL).open().single().place)
        assertArrayEquals(pcm, RawFile.of(dir, "OLD234").single().cut(TEST_SEAL, born, born + 100))
        assertEquals(setOf("saved-scene"), ClipLog(dir, "OLD234").done())

        assertTrue(restored.see(2, born)) // 명시적 동의 철회 세대가 도착함
        assertEquals(1, dropRaw(dir, "OLD234", below = 2))
        assertTrue(Outbox(dir, "OLD234", TEST_SEAL).recent(10).isEmpty())
        assertTrue(RawFile.of(dir, "OLD234").isEmpty())
        assertTrue(File(dir, "utterances-OLD234.jsonl").readLines().all {
            val cleared = Utterance.parse(TEST_SEAL.unline(it))
            cleared.text.isEmpty() && cleared.lat == null && cleared.lng == null
        })
    }

    @Test fun 무기한과_유한한_시험_기간은_시각_범위를_넘겨도_조기_만료하지_않음() {
        assertFalse(retentionExpired(1, Long.MAX_VALUE))
        assertFalse(retentionExpired(Long.MIN_VALUE, Long.MAX_VALUE))
        assertFalse(retentionExpired(Long.MAX_VALUE - 10, Long.MAX_VALUE, keepMs = 20))
        assertFalse(retentionExpired(100, 50, keepMs = 10)) // 기기 시계가 뒤로 이동함
        assertFalse(retentionExpired(100, 109, keepMs = 10))
        assertTrue(retentionExpired(100, 110, keepMs = 10))
    }

    @Test fun 데이터_키는_감싼_채_파일에_두고_다시_열면_같은_키() {
        val dir = tmp.root
        val a = Seal.wrapped(dir, TEST_SEAL)
        val line = a.line("바다는 왜 짜?")
        assertEquals("바다는 왜 짜?", Seal.wrapped(dir, TEST_SEAL).unline(line)) // 앱을 다시 켜도 같은 데이터 키
        val other = Seal(KeyGenerator.getInstance("AES").apply { init(256) }.generateKey())
        assertTrue(runCatching { Seal.wrapped(dir, other) }.isFailure) // 감싼 키(Keystore)가 바뀌면 열리지 않음
        assertEquals(setOf("vault.key"), dir.list()!!.toSet())
        assertTrue(sweep(dir, TEST_SEAL, 0).isEmpty()) // 키 파일은 여행 파일이 아님
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
