package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class DemoRouteTest {
    @Test fun parsesStopsInOrder() {
        assertEquals(listOf(Place(37.1, 127.2, "하나로마트"), Place(37.3, 127.4, "휴게소")), demoStops("37.1,127.2,하나로마트; 37.3,127.4,휴게소"))
    }

    @Test fun emptyOrMissingMeansNoStops() {
        assertEquals(emptyList<Place>(), demoStops(null))
        assertEquals(emptyList<Place>(), demoStops(""))
    }

    @Test fun dropsMalformedPartsAndKeepsAtMostTwo() {
        assertEquals(listOf(Place(1.0, 2.0, "a")), demoStops("x,2,b;1,2,a;1,2;91,2,c;1,2,"))
        assertEquals(2, demoStops("1,2,a;3,4,b;5,6,c").size)
    }

    @Test fun approachWindowCanBeWidenedForTheDemoOnly() {
        assertNull(approach("T", "하나로마트", 360)) // 6 minutes by road: no card by default
        assertNotNull(approach("T", "하나로마트", 360, limit = 600)) // --ei approachSeconds 600
        assertNull(approach("T", "하나로마트", 0, limit = 600)) // 0 still means no estimate
    }
}
