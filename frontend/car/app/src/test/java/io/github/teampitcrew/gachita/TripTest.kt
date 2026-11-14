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
        {"code":"AB23CD","title":"가치타 가족 여행","status":"boarding","recording":false,
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
        val s = Session(ours = setOf("p0")).withTrip(trip(false, false))
        assertNotNull(s.copy(gear = null).blockOn())
        assertNotNull(s.copy(gear = "D").blockOn())
        assertNotNull(s.copy(gear = "P", online = false).blockOn())
        assertNotNull(s.copy(gear = "P", busy = true).blockOn())
        assertNotNull(Session(gear = "P").blockOn()) // 여행 없음
        assertNull(s.copy(gear = "P").blockOn())
        assertNotNull(s.copy(gear = "P", ours = emptySet()).blockOn()) // 이 차가 참가시킨 사람이 없으면 켤 것이 없다
    }

    @Test fun `장면을 읽는다(구간은 있을 때만)`() {
        val t = parseTrip(json(true).replace("\"moments\":[]", "\"moments\":[{\"id\":\"m1\",\"at\":5000,\"label\":\"\"},{\"id\":\"m2\",\"at\":9000,\"from\":8000,\"to\":9500,\"label\":\"바다\"}]"))
        assertEquals(listOf(Moment("m1", 5000), Moment("m2", 9000, 8000, 9500)), t.moments)
    }

    @Test fun `여행의 동의 세대와 만든 시각을 읽는다`() {
        val t = parseTrip(json(true).replace("\"version\":3", "\"version\":3,\"generation\":4"))
        assertEquals(4, t.generation); assertEquals(1L, t.createdAt)
        assertEquals(1, trip(true).generation) // 세대가 없는 옛 응답은 1
    }

    @Test fun `동의가 모두 모여도 녹음 시작 전에는 준비 상태다`() {
        val s = Session(gear = "P", ours = setOf("p0")).turnedOn(trip(true, false))
        assertFalse(s.recording)
        assertTrue(s.switchOn)
        assertTrue(s.waitsFor(s.trip!!.people[1]))
        val all = s.withTrip(trip(true, true))
        assertTrue(all.waiting)
        assertFalse(all.recording)
        assertTrue(all.startRecording().recording)
    }

    @Test fun `처음과 재동의 후에는 명시적으로 시작해야 한다`() {
        val ready = Session(gear = "P").withTrip(trip(true, true))
        assertFalse(ready.recording)
        val recording = ready.startRecording()
        assertTrue(recording.recording)
        val again = recording.withTrip(trip(true, false)).withTrip(trip(true, true))
        assertFalse(again.started)
        assertFalse(again.recording)
        assertTrue(again.startRecording().recording)
    }

    @Test fun `시작 버튼은 주차 온라인 전원 동의 유휴 상태가 필요하다`() {
        val ready = Session(gear = "P").withTrip(trip(true, true))
        assertTrue(ready.startRecording().recording)
        assertFalse(ready.withGear("D").startRecording().recording)
        assertFalse(ready.withGear(null).startRecording().recording)
        assertFalse(ready.copy(online = false).startRecording().recording)
        assertFalse(ready.copy(busy = true).startRecording().recording)
        assertFalse(ready.withTrip(trip(true, false)).startRecording().recording)
        assertFalse(ready.turnOff().startRecording().recording)
        assertFalse(Session(gear = "P").startRecording().recording)
        assertFalse(Session(gear = "P").withTrip(trip()).startRecording().recording)
    }

    @Test fun `전원 철회는 서버 응답 전에 멈추고 재시작을 취소한다`() {
        val on = Session(gear = "P").withTrip(trip(true, true)).startRecording()
        val off = on.turnOff()
        assertFalse(off.recording)
        assertFalse(off.started)
        assertTrue(off.withTrip(trip(true, true)).offPending)
        assertFalse(off.withTrip(trip(false, false)).offPending)
        // 앞선 동의 켜기 응답이 늦게 와도 철회를 취소하지 않는다.
        assertTrue(off.turnedOn(trip(true, true)).offPending)
        assertFalse(off.turnedOn(trip(true, true)).recording)
    }

    @Test fun `개인 동의 철회는 그 사람에게만 전송하고 다른 동의는 유지한다`() {
        val off = Session(gear = "P").withTrip(trip(true, true)).startRecording().turnOff("p1")
        assertEquals(listOf("p1"), off.offTargets)
        assertFalse(off.recording)
        val synced = off.withTrip(trip(true, false))
        assertFalse(synced.offPending)
        assertTrue(synced.trip!!.people[0].consent)
        assertFalse(synced.withTrip(trip(true, true)).recording)
    }

    @Test fun `여러 사람의 오프라인 철회와 전원 철회 대상을 누적한다`() {
        val s = Session(gear = "P").withTrip(trip(true, true)).startRecording()
        assertEquals(listOf("p0", "p1"), s.turnOff("p0").turnOff("p1").offTargets)
        assertEquals(listOf("p0", "p1"), s.turnOff().turnOff("p1").offTargets)
        assertEquals(listOf("p0", "p1"), s.turnOff("p0").turnOff().offTargets)
    }

    @Test fun `개인 철회 전송 대기는 앱을 다시 켜도 유지된다`() {
        val back = Session.restore(json(true, true), offPending = true, started = true, withdrawn = setOf("p1"))
        assertFalse(back.recording)
        assertEquals(listOf("p1"), back.offTargets)
        assertNull(back.pollVersion)
        assertFalse(back.withTrip(trip(true, false)).offPending)
        assertTrue(back.withTrip(trip(true, false)).withdrawn.isEmpty())
    }

    @Test fun `연결이 끊겨도 이미 시작한 녹음은 유지하며 철회는 즉시 멈춘다`() {
        val s = Session(gear = "P").withTrip(trip(true, true)).startRecording().withGear("D").copy(online = false)
        assertTrue(s.recording)
        assertFalse(s.turnOff().recording)
        assertEquals("AB23CD", s.trip?.code)
    }

    @Test fun `이전 판의 전원 철회 저장값과 시작된 세션을 복원한다`() {
        val off = Session.restore(json(true, true), offPending = true, started = false)
        assertFalse(off.recording)
        assertEquals(listOf("p0", "p1"), off.offTargets)
        val on = Session.restore(json(true, true), offPending = false, started = true)
        assertTrue(on.recording)
        assertTrue(on.withGear("D").recording)
        assertFalse(Session.restore(json(true, true), false, false).withGear("P").recording)
    }

    @Test fun `주행 중 재동의 뒤 주차해도 자동으로 시작하지 않는다`() {
        val driving = Session(gear = "P").withTrip(trip(true, true)).startRecording().withGear("D")
        val again = driving.withTrip(trip(true, false)).withTrip(trip(true, true))
        assertTrue(again.waiting)
        assertFalse(again.startRecording().recording)
        assertFalse(again.withGear("P").recording)
        assertTrue(again.withGear("P").startRecording().withGear("D").recording)
    }

    @Test fun `조회 사이 철회 후 재동의했어도 세대가 바뀌면 명시 시작을 취소한다`() {
        val on = Session(gear = "P").withTrip(trip(true, true)).startRecording()
        val next = on.withTrip(trip(true, true).copy(generation = 2))
        assertFalse(next.recording)
        assertFalse(next.started)
        assertTrue(next.startRecording().recording)
    }
}
