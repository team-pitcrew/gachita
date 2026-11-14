package io.github.teampitcrew.gachita

import org.junit.Assert.*
import org.junit.Test

class RecordingStartTest {
    private val trip = parseTrip("""{"code":"AB23CD","generation":2,"status":"boarding","participants":[{"id":"p1","name":"운전자","seat":"ROW_1_LEFT","consent":true}],"requests":[],"moments":[],"version":1,"createdAt":1}""")

    @Test fun `일시정지로 취소한 시작은 늦은 동의 응답으로 되살아나지 않는다`() {
        val attempt = RecordingStartAttempt(trip.code, trip.generation, 1000)
        assertTrue(attempt.accepts(trip, 1001))
        assertTrue(attempt.finish())
        assertFalse(attempt.accepts(trip, 1100))
        assertFalse(attempt.finish())
    }

    @Test fun `Gleo 제한시간보다 먼저 닫고 늦은 서버 응답은 거절한다`() {
        val attempt = RecordingStartAttempt(trip.code, trip.generation, 1000)
        assertTrue(attempt.accepts(trip, 6999))
        assertFalse(attempt.accepts(trip, 7000))
        assertFalse(attempt.accepts(trip, 9000))
    }

    @Test fun `조회 중 여행이나 동의 세대가 바뀌면 시작하지 않는다`() {
        val attempt = RecordingStartAttempt(trip.code, trip.generation, 1000)
        assertFalse(attempt.accepts(trip.copy(code = "OTHER1"), 1100))
        assertFalse(attempt.accepts(trip.copy(generation = 3), 1100))
        assertFalse(attempt.accepts(null, 1100))
        assertFalse(Session(trip = trip, gear = "D").startRecording().recording)
        assertFalse(Session(trip = trip, gear = "P", offPending = true).startRecording().recording)
        assertTrue(Session(trip = trip, gear = "P").startRecording().recording)
    }
}
