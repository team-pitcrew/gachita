package io.github.teampitcrew.gachita

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 여행 전체 음성 올리기(FullAudio.kt)의 순수 부분: 원음 파일들을 이어 붙인 시간축과 4 MiB 조각. */
class FullAudioTest {
    @Test fun planSpansFirstStartToLastEnd() {
        val p = audioPlan(listOf(10_000L to 20_000L, 25_000L to 40_000L))!!
        assertEquals(10_000L, p.startedAt); assertEquals(40_000L, p.endsAt)
        assertEquals(30_000L * 32, p.bytes); assertEquals(30.0, p.seconds, 0.0); assertEquals(1, p.parts)
        assertNull("원음이 없으면 올리지 않는다", audioPlan(emptyList()))
        assertNull("8시간을 넘으면 서버가 받지 않는다", audioPlan(listOf(0L to 8 * 3600_000L + 1)))
        val long = audioPlan(listOf(0L to 300_000L))!! // 5분 = 9.6 MB
        assertEquals(3, long.parts)
        assertEquals(131_072L to 262_144L, long.part(1))
        assertEquals(262_144L to 300_000L, long.part(2))
        assertEquals("조각 크기의 합 = 전체", long.bytes, (0 until long.parts).sumOf { long.part(it).let { (a, b) -> (b - a) * 32 } })
    }

    @Test fun gapsAreSilenceAndSoundStaysInPlace() {
        // 파일 둘: [0, 2ms)와 [3ms, 4ms). 2~3ms는 기록 멈춤 → 무음
        val spans = listOf(0L to 2L, 3L to 4L)
        val plan = audioPlan(spans)!!
        val bytes = audioPart(plan, 0, spans) { i, a, b -> ByteArray(((b - a) * 32).toInt()) { (i + 1).toByte() } }
        assertEquals(4 * 32, bytes.size)
        assertArrayEquals(ByteArray(64) { 1 }, bytes.copyOfRange(0, 64))
        assertArrayEquals(ByteArray(32), bytes.copyOfRange(64, 96))
        assertArrayEquals(ByteArray(32) { 2 }, bytes.copyOfRange(96, 128))
        // 파일이 짧게 끝나면(꼬리가 쓰다 끊김) 나머지는 무음
        val short = audioPart(plan, 0, spans) { _, _, _ -> ByteArray(10) { 7 } }
        assertEquals(7.toByte(), short[0]); assertEquals(0.toByte(), short[10])
    }

    @Test fun labels() {
        assertEquals("전체 음성 업로드 중  82%", audioLabel(AudioState.UPLOADING, .82f))
        assertEquals("전체 음성 업로드 중  99%", audioLabel(AudioState.UPLOADING, 1f))
        assertEquals("전체 음성 업로드 완료", audioLabel(AudioState.READY, 1f))
        assertEquals("전체 음성 보관 기간(2일)이 지났어요", audioLabel(AudioState.EXPIRED, 1f))
    }
}
