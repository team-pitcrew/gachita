package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RideTest {
    @Test fun readsOurQrOnly() {
        assertEquals("abc", rideCode("""{"type":"gachita-ride","version":1,"code":"abc"}"""))
        assertNull(rideCode("""{"type":"gachita-ride","version":2,"code":"abc"}""")) // 모르는 판은 읽지 않음
        assertNull(rideCode("""{"type":"other","version":1,"code":"abc"}"""))
        assertNull(rideCode("""{"type":"gachita-ride","version":1,"code":""}"""))
        assertNull(rideCode("https://gachita.mangowhois.ai/#ABC123")) // 옛 참가 링크
        assertNull(rideCode("not json"))
    }

    @Test fun freeSeatsFromFront() {
        val t = Trip("C", "", "boarding", listOf(Person("1", "아빠", "ROW_1_LEFT", false), Person("2", "하은", "ROW_2_RIGHT", false)), 0, 1)
        assertEquals(listOf(Seat.ROW_1_RIGHT, Seat.ROW_2_LEFT, Seat.ROW_2_CENTER), freeSeats(t))
    }
}
