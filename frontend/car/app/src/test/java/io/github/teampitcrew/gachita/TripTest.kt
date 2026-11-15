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

    @Test fun `동의를 5분 넘게 확인하지 못하면 녹음을 멈추고 저절로 다시 켜지 않는다`() {
        val on = Session(gear = "P").withTrip(trip(true, true)).startRecording()
        assertTrue(on.consentUnseen(CONSENT_FRESH_MS - 1).recording) // 5분 안에는 잇는다
        val stopped = on.pollFailed(java.io.IOException()).consentUnseen(CONSENT_FRESH_MS)
        assertFalse(stopped.recording); assertFalse(stopped.started)
        assertEquals("동의를 5분 넘게 확인하지 못해 녹음을 멈췄어요. 연결된 뒤 다시 시작해 주세요", stopped.note)
        assertFalse("끊긴 동안에는 다시 시작하지 못함", stopped.startRecording().recording)
        val back = stopped.withTrip(trip(true, true)).copy(online = true) // 다시 닿아도 동의만 확인될 뿐
        assertFalse(back.recording); assertTrue(back.waiting)
        assertTrue("사람이 다시 눌러야 켜짐", back.startRecording().recording)
        // 녹음 중이 아니면 문구도 바꾸지 않는다
        val idle = Session(gear = "P", note = "x").withTrip(trip(true, false))
        assertEquals(idle, idle.consentUnseen(CONSENT_FRESH_MS * 10))
    }

    @Test fun `조회가 성공하면 지난 조회 실패 문구만 지운다(T122)`() {
        val failed = Session(note = "").pollFailed(ApiError(502, "error code: 502"))
        assertEquals("서버가 잠깐 응답하지 않아요. 다시 시도할게요", failed.note)
        assertTrue(failed.online) // 전처럼 연결된 것으로 센다(다른 화면이 연결 대기로 바뀌지 않게)
        assertEquals("", failed.polled().note)

        // 그사이 사용자가 한 일의 결과 문구는 남긴다
        val acted = failed.copy(note = "본인의 동의를 저장했어요. 녹음은 홈에서 시작해 주세요")
        assertEquals(acted.note, acted.polled().note)
        assertEquals("", acted.polled().pollNote)

        // 거절은 이유를 보이고 연결은 된 것으로, 닿지 않으면 문구를 바꾸지 않는다
        val refused = Session().pollFailed(ApiError(403, "동의는 본인만 켤 수 있음"))
        assertTrue(refused.online); assertEquals("서버가 거절했어요(403 동의는 본인만 켤 수 있음)", refused.note)
        val away = Session(note = "동의를 확인하고 있어요").pollFailed(java.io.IOException())
        assertFalse(away.online); assertEquals("동의를 확인하고 있어요", away.note); assertEquals("동의를 확인하고 있어요", away.polled().note)
    }

    @Test fun `동의 켜기가 잠깐 못 받아 실패하면 확인 못 함으로 적고 다음 조회에 지운다(T122)`() {
        val unsure = Session(busy = true).agreeFailed(ApiError(502, "error code: 502"))
        assertEquals("동의 저장을 확인하지 못했어요 · 서버가 잠깐 응답하지 않아요", unsure.note)
        assertFalse(unsure.busy)
        assertEquals("", unsure.polled().note) // 다음 조회가 실제 동의를 보인다

        val refused = Session(busy = true).agreeFailed(ApiError(403, "동의는 본인만 켤 수 있음"))
        assertEquals("동의를 저장하지 못했어요 · 서버가 거절했어요(403 동의는 본인만 켤 수 있음)", refused.note)
        assertEquals(refused.note, refused.polled().note) // 저장하지 못한 것은 남긴다
    }

    // 여행 제목 '{지역} {무리} 여행'(흐름점검 — 이번 시연 '정자 PITCREW 여행')
    @Test fun tripTitleFromDestinationAndGroup() {
        val pit = CarGroup("g1", "PITCREW", "guest", emptyList(), null)
        val fam = CarGroup("g2", "우리 가족", "family", emptyList(), null)
        assertEquals("정자 PITCREW 여행", tripTitle("정자 카페거리", pit, "함께하는 여행"))
        assertEquals("강릉 가족 여행", tripTitle(" 강릉  숙소", fam, "함께하는 여행"))
        assertEquals("PITCREW 여행", tripTitle(null, pit, "함께하는 여행"))
        assertEquals("함께하는 여행", tripTitle("", null, "함께하는 여행"))
    }

    // 폰 '기록 중지': 주행 중 서버 기록이 꺼지면 차도 멈춘다. 주차로 서버가 기록을 끈 것은 멈춤이 아니다
    @Test fun phoneStopStopsTheCarButParkingDoesNot() {
        val people = listOf(Person("a", "아빠", "ROW_1_LEFT", true))
        val driving = Trip("T1", "t", "driving", people, 0, 1, recording = true)
        val rec = Session(gear = "D", ours = setOf("a")).withTrip(driving).startRecording(auto = true)
        assertTrue(rec.recording)
        assertFalse(rec.withTrip(driving.copy(recording = false, version = 2)).recording) // 폰 '기록 중지'
        assertTrue(rec.withTrip(driving.copy(status = "parked", recording = false, version = 2)).recording) // 주차: 차는 계속
    }
}
