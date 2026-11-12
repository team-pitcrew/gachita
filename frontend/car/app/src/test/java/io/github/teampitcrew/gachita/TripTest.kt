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
        val s = Session(gear = "P").turnedOn(trip(true, true)).withGear("D").copy(online = false)
        assertTrue(s.recording)
        assertEquals("AB23CD", s.trip?.code)
    }

    @Test fun `끊긴 채 끄고 앱을 다시 켜도 멈춘 채이고, 연결되면 서버에 끄기를 다시 보낸다`() {
        val off = Session(gear = "P").turnedOn(trip(true, true)).copy(online = false).turnOff()
        // 앱은 마지막 여행 원문(모두 동의)과 두 표시를 저장해 두었다가 이것으로 되살린다
        val back = Session.restore(json(true, true), off.offPending, off.started)
        assertFalse(back.recording)
        assertFalse(back.agreed)
        assertEquals(listOf("p0", "p1"), back.offTargets) // 모두에게 동의 끄기를 다시 보냄
        assertNull(back.pollVersion) // 304로 놓치지 않게 version 없이 전체를 받음
        val synced = back.withTrip(trip(false, false))
        assertFalse(synced.offPending)
        assertTrue(synced.offTargets.isEmpty())
        assertEquals(3, synced.pollVersion)
    }

    @Test fun `기록 중에 앱이 다시 켜지면 저장한 시작 표시로 이어 간다`() {
        val on = Session(gear = "P").turnedOn(trip(true, true)).withGear("D")
        assertTrue(Session.restore(json(true, true), on.offPending, on.started).recording)
        assertFalse(Session.restore(json(true, true), false, false).recording) // 시작 표시가 없으면 주차할 때까지 대기
        assertTrue(Session.restore(json(true, true), false, false).waiting)
    }

    @Test fun `주행 중에 동의가 다시 채워지면 기록 대기, 주차하면 기록 중`() {
        val driving = Session(gear = "P").turnedOn(trip(true, true)).withGear("D")
        val revoked = driving.withTrip(trip(true, false)) // 폰에서 한 명이 끔
        assertFalse(revoked.recording)
        val again = revoked.withTrip(trip(true, true)) // 폰에서 다시 켬
        assertFalse(again.recording)
        assertTrue(again.waiting)
        assertTrue(again.withGear("P").recording)
        assertTrue(again.withGear("P").withGear("D").recording) // 한 번 시작하면 주행 중에도 이어 감
    }

    @Test fun `주차 중에 동의가 다시 채워지면 바로 기록 중`() {
        val s = Session(gear = "P").turnedOn(trip(true, true)).withTrip(trip(true, false)).withTrip(trip(true, true))
        assertTrue(s.recording)
    }

    @Test fun `기어를 모르면 동의가 채워져도 시작하지 않는다`() {
        assertTrue(Session().withTrip(trip(true, true)).waiting)
    }
}
