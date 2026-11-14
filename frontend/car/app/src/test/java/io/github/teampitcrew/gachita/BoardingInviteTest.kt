package io.github.teampitcrew.gachita

import org.junit.Assert.*
import org.junit.Test

class BoardingInviteTest {
    private val opaque = "a".repeat(43)
    private val url = "https://gachita.mangowhois.ai/?join=$opaque"
    private val invite = BoardingInvite("id", url, 301_000)
    private val trip = Trip("R", "여행", "boarding", listOf(Person("driver", "운전자", "ROW_1_LEFT", false)), 0, 1)

    @Test fun `차량 초대는 일반 폰 카메라가 열 URL이며 같은 서버만 허용한다`() {
        assertEquals(url, boardingInviteUrl("https://gachita.mangowhois.ai", "/?join=$opaque"))
        assertEquals(url, boardingInviteUrl("https://gachita.mangowhois.ai/", url))
        assertEquals("http://127.0.0.1:8787/?join=$opaque", boardingInviteUrl("http://127.0.0.1:8787", "/?join=$opaque"))
        for (bad in listOf("https://other.example/?join=$opaque", "//other.example/?join=$opaque", "/?join=$opaque&token=secret", "/?token=$opaque", "/?join=short", "/?join=$opaque#fragment", "/api?join=$opaque", "https://user@gachita.mangowhois.ai/?join=$opaque")) {
            assertTrue(bad, runCatching { boardingInviteUrl("https://gachita.mangowhois.ai", bad) }.isFailure)
        }
    }

    @Test fun `5분 초대는 정확한 만료시각부터 남은 시간이 0이다`() {
        assertEquals(300L, invite.secondsLeft(1_000))
        assertEquals(1L, invite.secondsLeft(300_999))
        assertEquals(0L, invite.secondsLeft(301_000))
        assertEquals(0L, invite.secondsLeft(900_000))
    }

    @Test fun `늦은 발급은 여행 서버 운전석 화면 주차가 그대로일 때만 보여준다`() {
        val attempt = BoardingInviteAttempt(7, "R", "origin", "driver")
        fun accepts(n: Int = 7, t: Trip? = trip, server: String = "origin", ours: Set<String> = setOf("driver"), parked: Boolean = true, visible: Boolean = true) = attempt.accepts(n, t, server, ours, parked, visible)
        assertTrue(accepts())
        assertFalse(accepts(n = 8))
        assertFalse(accepts(t = null))
        assertFalse(accepts(t = trip.copy(code = "S")))
        assertFalse(accepts(t = trip.copy(status = "driving")))
        assertFalse(accepts(t = trip.copy(people = listOf(trip.people.first().copy(seat = "ROW_1_RIGHT")))))
        assertFalse(accepts(server = "other"))
        assertFalse(accepts(ours = emptySet()))
        assertFalse(accepts(parked = false))
        assertFalse(accepts(visible = false))
    }

    @Test fun `발급 전 닫으면 발급 작업이 초대를 폐기하고 화면에 넘기지 않는다`() {
        val call = BoardingInviteCall()
        assertNull(call.cancel())
        assertFalse(call.issued(invite))
        assertNull(call.cancel())
    }

    @Test fun `발급 후 닫으면 초대를 한번만 폐기 대상으로 반환한다`() {
        val call = BoardingInviteCall()
        assertTrue(call.issued(invite))
        assertEquals(invite, call.cancel())
        assertNull(call.cancel())
        assertFalse(call.issued(invite))
    }
}
