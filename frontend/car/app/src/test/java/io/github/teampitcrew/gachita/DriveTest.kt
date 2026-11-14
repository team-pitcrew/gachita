package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DriveTest {
    private fun status(recording: Boolean = true, muted: Boolean = false, handoff: Handoff.State = Handoff.State.OFF, mic: Mic = Mic.ON,
                       offPending: Boolean = false, waiting: Boolean = false, inPark: Boolean = true, waitingFor: List<String> = emptyList(),
                       ended: Boolean = false, resumed: Boolean = false) =
        driveStatus(recording, muted, false, handoff, mic, "", offPending, waiting, inPark, waitingFor, ended, resumed)

    @Test fun statusFollowsDesignWording() {
        assertEquals(DriveStatus("기록 중", "아래 버튼으로 언제든 멈출 수 있어요", Hero.REC), status())
        assertEquals(DriveStatus("기록 멈춤", "같은 버튼을 누르면 다시 기록해요", Hero.PAUSED), status(muted = true))
        assertEquals("운전대 버튼을 누르세요", status(handoff = Handoff.State.WAITING).sub) // Gleo에게 넘김(T41)
        assertEquals(Hero.PAUSED, status(mic = Mic.BLOCKED).hero)
        assertEquals(Hero.PLAIN, status(mic = Mic.STARTING).hero)
        assertEquals("동의 철회", status(recording = false, offPending = true).title)
        assertEquals("주차(P)한 뒤 기록을 시작해 주세요", status(recording = false, waiting = true, inPark = false).sub)
        assertEquals("서준, 하은 · 녹음 동의가 필요해요", status(recording = false, waitingFor = listOf("서준", "하은")).sub)
    }

    @Test fun bigButtonKeepsTheOldActionRules() {
        assertEquals(DriveButton("기록 중지", Press.STOP, true), driveButton(recording = true, muted = false, agreed = true, restricted = true, canStart = false))
        assertEquals(DriveButton("기록 재개", Press.GO, true), driveButton(recording = true, muted = true, agreed = true, restricted = true, canStart = false))
        assertFalse(driveButton(recording = false, muted = false, agreed = true, restricted = true, canStart = true).enabled) // 시작은 주차 중에만
        assertEquals(DriveButton("기록 시작", Press.GO, true), driveButton(recording = false, muted = false, agreed = true, restricted = false, canStart = true))
        assertEquals(Press.OFF, driveButton(recording = false, muted = false, agreed = true, restricted = false, canStart = false).press) // 처리 중·끊김
        assertEquals("동승자 설정", driveButton(recording = false, muted = false, agreed = false, restricted = false, canStart = false).label)
        assertFalse(driveButton(recording = false, muted = false, agreed = false, restricted = true, canStart = false).enabled)
    }

    @Test fun heardMetaNeverNamesFromSeat() {
        assertEquals("서준 / 뒷좌석", heardMeta("서준", "ROW_2_LEFT", null))
        assertEquals("엄마 / 조수석", heardMeta("엄마", "ROW_1_RIGHT", 1)) // 확인된 사람의 자리가 구역보다 앞
        assertEquals("말한 사람 미확인 / 앞좌석", heardMeta(null, null, 0))
        assertEquals("말한 사람 미확인", heardMeta(null, null, null))
    }

    @Test fun resumedAndEndedStates() {
        assertEquals("중지한 지점부터 이어서 기록해요", status(resumed = true).sub) // 2026:1969
        assertEquals("아래 버튼으로 언제든 멈출 수 있어요", status(resumed = false).sub)
        assertEquals(DriveStatus("여행 기록 완료", "오늘의 대화를 오래 간직해 보세요", Hero.PAUSED), status(recording = false, ended = true)) // 2026:2410
        assertEquals("동의 철회", status(recording = false, offPending = true, ended = true).title) // 철회 중이면 그 안내가 먼저
        assertEquals(DriveButton("새 여행 시작", Press.GO, true), driveButton(recording = false, muted = false, agreed = true, restricted = false, canStart = false, ended = true))
        assertFalse(driveButton(recording = false, muted = false, agreed = true, restricted = true, canStart = false, ended = true).enabled)
        assertEquals("현재 주행 / 대화 기록 중", liveChip(true)) // 2026:2308
        assertEquals("현재 주행 / 대화 기록 멈춤", liveChip(false)) // 2026:2358
    }

    @Test fun endedTripNeverRecords() {
        val people = listOf(Person("a", "아빠", "ROW_1_LEFT", true))
        val live = Trip("T1", "t", "driving", people, 0, 1)
        val rec = Session(gear = "P", ours = setOf("a")).withTrip(live).startRecording()
        assertTrue(rec.recording)
        val ended = rec.withTrip(live.copy(status = "ended", version = 2))
        assertFalse(ended.recording) // 폰에서 '여행 끝내기'를 누르면 차도 녹음을 멈춘다. 동의는 그대로
        assertTrue(ended.agreed)
        assertEquals("끝난 여행이에요. 새 여행에서 녹음을 시작해 주세요", ended.blockStart())
    }

    @Test fun seatCharacterFollowsSeatOrder() {
        assertEquals(0, seatCharacter(Person("a", "아빠", "ROW_1_LEFT", true)))
        assertEquals(4, seatCharacter(Person("b", "하은", "ROW_2_RIGHT", true)))
        assertEquals(0, seatCharacter(Person("c", "손님", "ROW_3_LEFT", true)))
    }
}
