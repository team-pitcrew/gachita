package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Test

class DemoPathTest {
    @Test fun pathIsWalkedEvenlyAndClamped() {
        val p = parsePath("37.5045,127.0244; 37.4844,127.0343;bad;37.3666,127.1078")
        assertEquals(3, p.size)
        assertEquals(37.5045 to 127.0244, alongPath(p, -1.0)) // 받기 전·처음은 출발
        assertEquals(37.4844, alongPath(p, .5).first, 1e-9) // 가운데 점
        assertEquals(37.3666 to 127.1078, alongPath(p, 2.0)) // 끝나면 목적지에 머묾
        assertEquals((37.5045 + 37.4844) / 2, alongPath(p, .25).first, 1e-9)
        assertEquals(emptyList<Pair<Double, Double>>(), parsePath(""))
    }
}
