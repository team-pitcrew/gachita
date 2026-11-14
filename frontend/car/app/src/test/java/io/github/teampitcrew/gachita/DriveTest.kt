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
        assertEquals("모두 동의했어요. 출발하면 자동으로 기록해요", status(recording = false, waiting = true, inPark = true).sub)
        assertEquals("서준, 하은 · 녹음 동의가 필요해요", status(recording = false, waitingFor = listOf("서준", "하은")).sub)
    }

    @Test fun bigButtonHasNoStartButton() {
        assertEquals(DriveButton("일시정지", Press.STOP, true), driveButton(recording = true, muted = false, agreed = true, restricted = true)) // A control/live 2107:5585
        assertEquals(DriveButton("계속 기록", Press.GO, true), driveButton(recording = true, muted = true, agreed = true, restricted = true)) // A control/paused 2107:5589
        assertEquals(DriveButton("출발하면 자동으로 기록해요", Press.OFF, false), driveButton(recording = false, muted = false, agreed = true, restricted = false)) // C03·C13
        assertFalse(driveButton(recording = false, muted = false, agreed = true, restricted = true).enabled)
        assertEquals("동승자 설정", driveButton(recording = false, muted = false, agreed = false, restricted = false).label)
        assertFalse(driveButton(recording = false, muted = false, agreed = false, restricted = true).enabled)
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
        assertEquals(DriveButton("새 여행 시작", Press.GO, true), driveButton(recording = false, muted = false, agreed = true, restricted = false, ended = true))
        assertFalse(driveButton(recording = false, muted = false, agreed = true, restricted = true, ended = true).enabled)
        assertEquals("대화 기록 중", liveChip(true)) // 2026:2308(개정)
        assertEquals("대화 기록 멈춤", liveChip(false)) // 2026:2358, 개정된 2026:2308과 같은 꼴
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

    @Test fun shellFollowsTheScreenNotTheWidth() {
        assertEquals(Shell.RIDE, tripShell(parked = true, showsBrief = false, contentTab = false)) // C44·D33·ended: 주차 중에도 '연결됨'
        assertEquals(Shell.RIDE, tripShell(parked = false, showsBrief = false, contentTab = false)) // C17·C21
        assertEquals(Shell.PARKED, tripShell(parked = true, showsBrief = true, contentTab = false)) // C20·D19·finalBrief: '주차 중  P'
        assertEquals(Shell.PARKED, tripShell(parked = true, showsBrief = false, contentTab = true)) // C22–C38
        assertEquals(Shell.RIDE, tripShell(parked = false, showsBrief = true, contentTab = false)) // 주행 중에는 브리핑이 없다
    }

    @Test fun seatCharacterFollowsSeatOrder() {
        assertEquals(0, seatCharacter(Person("a", "아빠", "ROW_1_LEFT", true)))
        assertEquals(4, seatCharacter(Person("b", "하은", "ROW_2_RIGHT", true)))
        assertEquals(0, seatCharacter(Person("c", "손님", "ROW_3_LEFT", true)))
    }

    @Test fun recordClockShowsHoursMinutesSeconds() {
        assertEquals("00:00:00", recordClock(999))
        assertEquals("00:12:48", recordClock(768_000)) // A D17·D18
        assertEquals("00:38:14", recordClock(2_294_000)) // A D20
        assertEquals("01:02:03", recordClock(3_723_000))
        assertEquals("00:00:00", recordClock(-5))
        assertEquals(WAVE_BARS, DESIGN_WAVE.size) // 시안 wave/live 2107:5463 막대 60개
    }

    @Test fun briefFoldsAsksIntoShortActions() {
        val trash = SharedTodo("n4", "마트", "쓰레기 정리하기", "pending", 0, emptyList(), "remember", listOf(TodoItem("쓰레기", null)), listOf("dad"), "쓰레기 정리하기")
        // A D20 '화장실 가기 / 장보기 / 쓰레기 정리하기'
        assertEquals(listOf(NearRow(BriefIcon.RESTROOM, "화장실 가기"), NearRow(BriefIcon.CART, "장보기"), NearRow(BriefIcon.TRASH, "쓰레기 정리하기")),
            nearRows(F4Mock.martNear.take(2) + trash))
        // every thing to buy is one '장보기' row; at most three rows; anything else keeps its title with a mark by its words
        assertEquals(listOf(NearRow(BriefIcon.CART, "장보기")), nearRows(F4Mock.mart.drop(1)))
        assertEquals(listOf(NearRow(BriefIcon.RESTROOM, "화장실 가기"), NearRow(BriefIcon.COLD, "고기는 바로 냉장 보관"), NearRow(BriefIcon.LUGGAGE, "체크인하고 가방 내리기")),
            nearRows(F4Mock.lodge))
        val old = SharedTodo("o", "마트", "우유 꼭 사기", "pending", 0, emptyList()) // 이전 서버: 분류·제목 없음
        assertEquals(listOf(NearRow(BriefIcon.DRINK, "우유 꼭 사기")), nearRows(listOf(old))) // 도착 브리핑과 같은 그림(Twemoji 🥤)
        assertTrue(nearRows(F4Mock.mart + F4Mock.lodge).size <= 3)
    }

    @Test fun gridHidesOnlyAnEmptyMiddleSeat() {
        val rows = seatRows(emptyList())
        val four = gridSeats(rows, F4Mock.people)
        assertEquals(listOf(listOf(Seat.ROW_1_LEFT, Seat.ROW_1_RIGHT), listOf(Seat.ROW_2_LEFT, Seat.ROW_2_RIGHT)), four) // A 2×2
        val middle = F4Mock.people.take(3) + Person("g", "할머니", "ROW_2_CENTER", true)
        assertEquals(listOf(Seat.ROW_2_LEFT, Seat.ROW_2_CENTER, Seat.ROW_2_RIGHT), gridSeats(rows, middle)[1])
    }

    @Test fun meIsTheDriverWithAProfile() {
        val dad = Person("a", "민준", "ROW_1_LEFT", true, profile = true)
        assertEquals(dad, mePerson(listOf(Person("b", "엄마", "ROW_1_RIGHT", true, profile = true), dad)))
        assertEquals(null, mePerson(listOf(Person("c", "손님", "ROW_1_LEFT", true)))) // 손님 운전자는 이 차의 계정이 아님
    }

    @Test fun seatFacesFollowTheGroupProfile() {
        assertEquals(R.drawable.char_glasses, faceRes(Person("a", "아빠", "ROW_1_LEFT", true, profile = true, character = "glasses"))) // 시안 A 아빠
        assertEquals(R.drawable.char_cap, faceRes(Person("s", "서준", "ROW_2_LEFT", true, profile = true, character = "cap-small")))
        assertEquals(R.drawable.char_basic, faceRes(Person("g", "손님", "ROW_1_LEFT", true))) // 손님은 자리 순서
        assertEquals(R.drawable.char_cap, faceRes(Person("g", "손님", "ROW_1_RIGHT", true)))
    }
}
