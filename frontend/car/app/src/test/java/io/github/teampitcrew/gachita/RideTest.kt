package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Test

class RideTest {
    @Test fun freeSeatsFollowVehicleCapabilities() {
        val t = Trip("C", "", "boarding", listOf(Person("1", "아빠", "ROW_1_LEFT", false)), 0, 1)
        assertEquals(listOf(Seat.ROW_1_RIGHT), freeSeats(t, listOf("ROW_1_LEFT", "ROW_1_RIGHT")))
        assertEquals(emptyList<Seat>(), freeSeats(t, listOf("ROW_1_LEFT")))
        assertEquals(emptyList<Seat>(), freeSeats(t, listOf("ROW_3_LEFT")))
        assertEquals(4, freeSeats(t, emptyList()).size)
    }

    @Test fun freeSeatsFromFront() {
        val t = Trip("C", "", "boarding", listOf(Person("1", "아빠", "ROW_1_LEFT", false), Person("2", "하은", "ROW_2_RIGHT", false)), 0, 1)
        assertEquals(listOf(Seat.ROW_1_RIGHT, Seat.ROW_2_LEFT, Seat.ROW_2_CENTER), freeSeats(t))
    }
}
