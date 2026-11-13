package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Test

class SeatRowsTest {
    @Test fun carSeatsMakeRows() {
        // Pleos 에뮬레이터의 SEAT_OCCUPANCY 영역(0x1·0x4·0x10·0x20·0x40), 차가 주는 순서 그대로
        val rows = seatRows(listOf("ROW_1_LEFT", "ROW_1_RIGHT", "ROW_2_LEFT", "ROW_2_RIGHT", "ROW_2_CENTER"))
        assertEquals(listOf(listOf(Seat.ROW_1_LEFT, Seat.ROW_1_RIGHT), listOf(Seat.ROW_2_LEFT, Seat.ROW_2_CENTER, Seat.ROW_2_RIGHT)), rows)
    }

    @Test fun missingSeatIsNotDrawn() {
        assertEquals(listOf(listOf(Seat.ROW_1_LEFT, Seat.ROW_1_RIGHT), listOf(Seat.ROW_2_LEFT, Seat.ROW_2_RIGHT)), seatRows(listOf("ROW_1_LEFT", "ROW_1_RIGHT", "ROW_2_LEFT", "ROW_2_RIGHT", "ROW_3_LEFT")))
    }

    @Test fun noCarSeatsFallsBackToFiveSeats() {
        assertEquals(listOf(2, 3), seatRows(emptyList()).map { it.size })
    }
}
