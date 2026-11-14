package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 목소리 등록 파형(VoiceMeter.kt): 막대가 실제 소리 크기를 따르고 지난 칸은 멈춘다. 웹 voice-meter.js와 같은 눈금. */
class VoiceMeterTest {
    private fun chunk(amp: Int): Pair<Chunk, Int> {
        val buf = ShortArray(3200) { i -> (if (i / 2 % 2 == 0) amp else -amp).toShort() } // 0.1초, 2채널
        return downmix(buf, buf.size) to buf.size
    }

    @Test fun `조각 RMS와 막대 비율 - 무음 0, 큰 소리 1, 그 사이 dB 비례`() {
        val (loud, n) = chunk(16384) // 좌+우 각 0.5 → RMS 0.5
        assertEquals(0.5, chunkRms(loud, n), 1e-9)
        assertEquals(0.0, meterLevel(0.0), 0.0)
        assertEquals(0.0, meterLevel(0.001), 0.0) // −60 dBFS
        assertEquals(1.0, meterLevel(0.6), 0.0)
        assertEquals(0.3, meterLevel(0.01), 1e-9) // −40 dBFS
    }

    @Test fun `칸은 그 동안의 평균, 지난 칸은 뒤 소리에 바뀌지 않음, 범위 밖은 버림`() {
        val m = VoiceMeter(30, 15.0)
        m.add(0.1, 0.4); m.add(0.3, 0.2) // 첫 칸(0~0.5초)
        m.add(0.7, 0.9) // 둘째 칸
        m.add(0.2, 0.0).let { } // 첫 칸에 늦게 온 무음도 평균에 들어간다
        val a = m.snapshot()
        assertEquals(0.2, a[0], 1e-9)
        assertEquals(0.9, a[1], 1e-9)
        assertEquals(0.0, a[2], 0.0)
        m.add(1.2, 1.0); m.add(99.0, 1.0)
        val b = m.snapshot()
        assertEquals(a[1], b[1], 0.0)
        assertTrue(b[2] > 0.9)
        assertEquals(30, m.slotAt(99.0))
    }
}
