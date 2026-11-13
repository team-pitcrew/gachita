package io.github.teampitcrew.gachita

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import javax.crypto.KeyGenerator

class RawTest {
    @get:Rule val tmp = TemporaryFolder()

    /** 0.1초 묶음 k개. 표본 값 = 묶음 번호 × 10000 + 묶음 안의 위치라 잘린 자리를 값으로 알 수 있다. */
    private fun chunk(k: Int) = ByteBuffer.allocate(CHUNK_FRAMES * 2).order(ByteOrder.LITTLE_ENDIAN).apply {
        repeat(CHUNK_FRAMES) { putShort(((k * 10_000 + it) % 32_000).toShort()) }
    }.array()

    private fun record(dir: File, n: Int, start: Long = 1_000_000L, gen: Int = 1, trip: String = "ABC234") =
        RawWriter(dir, trip, gen, start, TEST_SEAL).use { w -> repeat(n) { w.write(chunk(it)) }; w.file }

    private fun sample(pcm: ByteArray, i: Int) = ByteBuffer.wrap(pcm, i * 2, 2).order(ByteOrder.LITTLE_ENDIAN).short.toInt()

    @Test fun 구간을_표본_단위로_자름() {
        val f = RawFile(record(tmp.root, 30)) // 3초
        assertEquals("ABC234", f.trip); assertEquals(1, f.generation); assertEquals(1_000_000L, f.startedAt)
        val pcm = f.cut(TEST_SEAL, 1_000_250, 1_001_250)!! // 0.25초 ~ 1.25초
        assertEquals(16_000 * 2, pcm.size) // 1초 = 16,000표본
        assertEquals(2 * 10_000 + 800, sample(pcm, 0)) // 0.25초 = 묶음 2의 800번째
        assertEquals(12 * 10_000 + 799 - 96_000, sample(pcm, 15_999)) // 1.25초 직전 = 묶음 12의 799번째(값은 32000으로 돎)
        assertArrayEquals(chunk(0), f.cut(TEST_SEAL, 999_000, 1_000_100)) // 앞이 파일 밖이면 있는 데부터
        assertEquals(30 * CHUNK_FRAMES * 2, f.cut(TEST_SEAL, 1_000_000, 1_009_000)!!.size) // 뒤가 파일 밖이면 있는 데까지
        assertNull(f.cut(TEST_SEAL, 1_010_000, 1_011_000)) // 이 파일에 없는 시각
    }

    @Test fun 원음_파일에_평문이_없고_다른_키로는_열리지_않음() {
        val file = record(tmp.root, 5)
        val bytes = file.readBytes()
        val plain = chunk(3).copyOfRange(0, 64)
        assertFalse(bytes.toList().windowed(plain.size).any { it == plain.toList() })
        val other = Seal(KeyGenerator.getInstance("AES").apply { init(256) }.generateKey())
        assertTrue(runCatching { RawFile(file).cut(other, 1_000_000, 1_000_500) }.isFailure)
    }

    @Test fun 쓰다_끊긴_꼬리는_버림() {
        val file = record(tmp.root, 10)
        file.writeBytes(file.readBytes().copyOf(file.length().toInt() - 100))
        assertEquals(9 * CHUNK_FRAMES * 2, RawFile(file).cut(TEST_SEAL, 1_000_000, 1_002_000)!!.size)
    }

    @Test fun WAV_머리는_16kHz_모노_16비트() {
        val w = wav(ByteArray(3_200))
        val b = ByteBuffer.wrap(w).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals("RIFF", String(w, 0, 4)); assertEquals("WAVE", String(w, 8, 4)); assertEquals("data", String(w, 36, 4))
        assertEquals(1, b.getShort(22).toInt()); assertEquals(16_000, b.getInt(24)); assertEquals(16, b.getShort(34).toInt())
        assertEquals(3_200, b.getInt(40)); assertEquals(44 + 3_200, w.size)
    }

    @Test fun 장면_구간은_있으면_그대로_없으면_앞_20초_뒤_10초_60초까지() {
        assertEquals(80_000L..110_000L, Moment("m", 100_000).window)
        assertEquals(95_000L..105_000L, Moment("m", 100_000, 95_000, 105_000).window)
        assertEquals(0L..60_000L, Moment("m", 50_000, 0, 90_000).window)
    }

    @Test fun 구간_시작을_덮는_수음_파일을_고름() {
        val dir = tmp.root
        val a = record(dir, 1, start = 1_000); val b = record(dir, 1, start = 5_000); record(dir, 1, start = 9_000, trip = "XYZ567")
        val files = RawFile.of(dir, "ABC234")
        assertEquals(2, files.size)
        assertEquals(b, clipFile(files, 6_000L..7_000L)!!.file) // 시작 전에 시작한 가장 늦은 수음
        assertEquals(a, clipFile(files, 0L..2_000L)!!.file) // 앞에 없으면 구간 안에서 시작한 가장 이른 것
        assertNull(clipFile(files, 0L..500L))
    }

    @Test fun 동의_세대가_바뀌면_옛_세대_원음만_지우고_48시간은_여행_파일과_같이() {
        val dir = tmp.root
        record(dir, 1, gen = 1); val now = record(dir, 1, gen = 2, start = 2_000_000)
        ClipLog(dir, "ABC234").add("m1")
        assertEquals(1, dropRaw(dir, "ABC234", below = 2))
        assertEquals(listOf(now), RawFile.of(dir, "ABC234").map { it.file })
        assertEquals(setOf("m1"), ClipLog(dir, "ABC234").done)
        dropTrip(dir, "ABC234")
        assertTrue(dir.list()!!.isEmpty()) // 원음과 올린 장면 기록도 여행 파일이다
    }
}
