package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TripTest {
    // backend/api가 돌려주는 모양(openapi.yaml의 Trip)
    private fun json(vararg consent: Boolean, requests: String = "[]") = """
        {"code":"AB23CD","title":"같이타 가족 여행","status":"boarding","recording":false,
         "participants":[${consent.mapIndexed { i, c -> """{"id":"p$i","name":"사람$i","seat":"ROW_1_LEFT","prefs":{},"consent":$c}""" }.joinToString(",")}],
         "requests":$requests,"moments":[],"version":3,"createdAt":1}
    """.trimIndent()

    private fun trip(vararg consent: Boolean) = parseTrip(json(*consent))

    @Test fun `여행 응답을 읽고 보관한 부탁만 센다`() {
        val t = parseTrip(json(true, false, requests = """[
            {"id":"r1","by":"p0","text":"화장실","when":"now","status":"held","createdAt":1},
            {"id":"r2","by":"p1","text":"간식","when":"now","status":"reflected","createdAt":2},
            {"id":"r3","by":"p1","text":"바다","when":"now","status":"held","createdAt":3}]"""))
        assertEquals("AB23CD", t.code)
        assertEquals(3, t.version)
        assertEquals(listOf(true, false), t.people.map { it.consent })
        assertEquals(2, t.heldRequests)
    }

    @Test fun `처음에는 기록하지 않는다`() {
        assertFalse(Session().recording)
        assertFalse(Session(gear = "P").withTrip(trip(false, false)).recording)
    }

    @Test fun `주차 중이고 서버에 닿을 때만 켤 수 있다`() {
        val s = Session().withTrip(trip(false, false))
        assertNotNull(s.copy(gear = null).blockOn())
        assertNotNull(s.copy(gear = "D").blockOn())
        assertNotNull(s.copy(gear = "P", online = false).blockOn())
        assertNotNull(s.copy(gear = "P", busy = true).blockOn())
        assertNotNull(Session(gear = "P").blockOn()) // 여행 없음
        assertNull(s.copy(gear = "P").blockOn())
    }

    @Test fun `서버가 모두의 동의를 저장하면 기록 중`() {
        val s = Session(gear = "P").withTrip(trip(false, false)).turnedOn(trip(true, true))
        assertTrue(s.recording)
    }

    @Test fun `참가자가 없으면 기록하지 않는다`() {
        assertFalse(Session(gear = "P").withTrip(trip()).recording)
    }

    @Test fun `끄면 서버 응답 전에 바로 멈추고, 서버가 따라오면 대기를 푼다`() {
        val on = Session(gear = "P").turnedOn(trip(true, true))
        val off = on.turnOff()
        assertFalse(off.recording)
        assertFalse(off.withTrip(trip(true, true)).recording) // 서버가 아직 켜짐이어도 다시 켜지지 않는다
        assertTrue(off.withTrip(trip(true, true)).offPending)
        assertFalse(off.withTrip(trip(false, false)).offPending)
    }

    @Test fun `끄기 대기 중에 다시 켜면 대기를 지운다`() {
        val s = Session(gear = "P").turnedOn(trip(true, true)).turnOff().turnedOn(trip(true, true))
        assertTrue(s.recording)
    }

    @Test fun `폰에서 한 명이라도 동의를 끄면 멈춘다`() {
        val s = Session(gear = "P").turnedOn(trip(true, true)).withTrip(trip(true, false))
        assertFalse(s.recording)
    }

    @Test fun `연결이 끊겨도 마지막 여행과 기록 상태를 그대로 둔다`() {
        val s = Session(gear = "D").turnedOn(trip(true, true)).copy(online = false)
        assertTrue(s.recording)
        assertEquals("AB23CD", s.trip?.code)
    }
}
