package io.github.teampitcrew.gachita

import org.junit.Assert.*
import org.junit.Test

class BoardingTest {
    private val trip = Trip("T", "여행", "boarding", listOf(Person("a", "가", "ROW_1_LEFT", true), Person("b", "나", "ROW_2_RIGHT", false)), 0, 1)

    @Test fun `현재 자리와 빈자리만 선택하고 없는 차량 좌석은 막는다`() {
        assertFalse(selectableSeat(trip, emptyList(), Seat.ROW_1_LEFT))
        assertTrue(selectableSeat(trip, emptyList(), Seat.ROW_1_LEFT, "a"))
        assertFalse(selectableSeat(trip, emptyList(), Seat.ROW_2_RIGHT, "a"))
        assertTrue(selectableSeat(trip, emptyList(), Seat.ROW_1_RIGHT, "a"))
        assertFalse(selectableSeat(trip, listOf("ROW_1_LEFT"), Seat.ROW_1_RIGHT, "a"))
        assertFalse(selectableSeat(trip, emptyList(), null))
    }

    @Test fun `좌석 조회 후 다른 참가자가 찬 자리는 확정할 수 없다`() {
        assertTrue(selectableSeat(trip, emptyList(), Seat.ROW_1_RIGHT))
        val refreshed = trip.copy(people = trip.people + Person("c", "다", "ROW_1_RIGHT", false))
        assertFalse(selectableSeat(refreshed, emptyList(), Seat.ROW_1_RIGHT))
    }

    @Test fun `초대 만료 권한 자리충돌과 연결실패의 다음 행동을 구분한다`() {
        assertTrue(boardingFailure(ApiError(404, "없는 연결")).contains("새 참석 QR"))
        assertTrue(boardingFailure(ApiError(410, "만료")).contains("차에서 새 참석 QR"))
        assertTrue(boardingFailure(ApiError(403, "운전석만 발급")).contains("운전석"))
        assertTrue(boardingFailure(ApiError(409, "이미 찬 자리")).contains("빈자리"))
        assertTrue(boardingFailure(java.io.IOException()).contains("연결 완료를 확인하지 못했어요"))
    }
}
