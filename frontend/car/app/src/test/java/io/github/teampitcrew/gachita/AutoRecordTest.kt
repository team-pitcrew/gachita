package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 자동 기록(C03 '탑승 시 대화 자동 기록', C13 '다음 탑승부터 자동 기록 켜짐'): 동의 규칙은 그대로, 시작 단추만 없다. */
class AutoRecordTest {
    private val all = listOf(Person("a", "아빠", "ROW_1_LEFT", true), Person("b", "엄마", "ROW_1_RIGHT", true))
    private fun trip(status: String = "driving", recording: Boolean = true, people: List<Person> = all, version: Int = 2) =
        Trip("T1", "t", status, people, 0, version, recording = recording)
    private fun session(t: Trip, gear: String = "D") = Session(gear = gear, ours = setOf("a", "b")).withTrip(t)

    @Test fun startsWhenServerTurnsRecordingOnWhileDriving() {
        val s = session(trip())
        assertTrue(s.autoStart)
        assertNull(s.blockAutoStart()) // 기어 D여도 자동 시작은 막지 않는다(누르는 것이 없음)
        assertTrue(s.startRecording(auto = true).recording)
        assertFalse(s.startRecording().recording) // 손으로 시작하는 길은 지금처럼 주차 중에만
    }

    @Test fun neverWithoutEveryonesConsent() {
        val one = all.mapIndexed { i, p -> if (i == 1) p.copy(consent = false) else p }
        assertFalse(session(trip(people = one)).autoStart) // 한 사람이라도 동의하지 않음
        assertFalse(session(trip(recording = false)).autoStart) // 서버가 기록을 켜지 않음(주행 전환 때 동의 전이었거나 철회)
        assertFalse(session(trip(status = "boarding")).autoStart) // 아직 출발 전
        assertFalse(session(trip(status = "parked")).autoStart)
        assertFalse(session(trip(status = "ended", recording = false)).autoStart)
        assertFalse(session(trip()).turnOff().autoStart) // 철회는 바로 멈추고 다시 켜지 않는다
        assertFalse(session(trip()).copy(online = false).autoStart)
        assertEquals("탑승자 모두의 녹음 동의가 필요해요", session(trip(people = all.map { it.copy(consent = false) })).blockAutoStart())
    }

    @Test fun pausedRecordingIsNotRestartedAutomatically() {
        val started = session(trip()).startRecording(auto = true)
        assertTrue(started.recording)
        assertFalse(started.autoStart) // 사용자가 '기록 중지'를 눌러도 started는 남아 자동 시작이 덮지 않는다(재개는 같은 단추)
    }

    @Test fun parsesServerRecordingFlag() {
        val base = """"code":"ABC123","title":"t","status":"driving","participants":[],"requests":[],"version":1,"createdAt":1"""
        assertTrue(parseTrip("{$base,\"recording\":true}").recording)
        assertFalse(parseTrip("{$base}").recording)
    }
}
