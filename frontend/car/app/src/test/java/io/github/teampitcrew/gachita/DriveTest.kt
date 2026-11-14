package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import androidx.compose.ui.unit.dp

class DriveTest {
    private fun note(recording: Boolean = true, muted: Boolean = false, handoff: Handoff.State = Handoff.State.OFF, mic: Mic = Mic.ON,
                     offPending: Boolean = false, waiting: Boolean = false, inPark: Boolean = true, waitingFor: List<String> = emptyList(),
                     ended: Boolean = false) =
        driveNote(recording, muted, handoff, mic, "", offPending, waiting, inPark, waitingFor, ended)

    // 시안 C17에는 상태 칸이 없다: 기록 중·일시정지·마친 여행은 시안 제목('방금 받아 적은 말 N건'·'멈추기 전 마지막 대화'), 그 밖은 까닭을 제목 자리에
    @Test fun heardTitleTellsOnlyWhatTheDesignLacks() {
        assertEquals(null, note())
        assertEquals(null, note(muted = true))
        assertEquals(null, note(recording = false, ended = true))
        assertEquals("운전대 버튼을 누르세요", note(handoff = Handoff.State.WAITING)) // Gleo에게 넘김(T41)
        assertEquals("마이크를 쓸 수 있으면 다시 기록해요", note(mic = Mic.BLOCKED))
        assertEquals("마이크를 켜고 있어요", note(mic = Mic.STARTING))
        assertEquals("원음과 대화를 지우고 있어요", note(recording = false, offPending = true))
        assertEquals("원음과 대화를 지우고 있어요", note(recording = false, offPending = true, ended = true)) // 철회 중이면 그 안내가 먼저
        assertEquals("모두 동의했어요. 출발하면 자동으로 기록해요", note(recording = false, waiting = true, inPark = true))
        assertEquals("서준, 하은 · 녹음 동의가 필요해요", note(recording = false, waitingFor = listOf("서준", "하은")))
    }

    // 녹음 막대의 ⏸/●(시안 C17 2137:5845 · C17p 2137:5853). 큰 단추·다른 화면으로 가는 단추는 없다
    @Test fun recordBarControl() {
        assertEquals(DriveButton("일시정지", Press.STOP, true), driveButton(recording = true, muted = false, agreed = true))
        assertEquals(DriveButton("녹화 재개", Press.GO, true), driveButton(recording = true, muted = true, agreed = true))
        assertEquals(DriveButton("녹화 재개", Press.GO, true), driveButton(recording = false, muted = false, agreed = true)) // 모두 동의 → 손으로 시작
        assertEquals(DriveButton("녹화 재개", Press.OFF, false), driveButton(recording = false, muted = false, agreed = false)) // 동의 전: 꺼짐
    }

    @Test fun heardMetaNeverNamesFromSeat() {
        assertEquals("서준 / 뒷좌석", heardMeta("서준", "ROW_2_LEFT", null))
        assertEquals("엄마 / 조수석", heardMeta("엄마", "ROW_1_RIGHT", 1)) // 확인된 사람의 자리가 구역보다 앞
        assertEquals("말한 사람 미확인 / 앞좌석", heardMeta(null, null, 0))
        assertEquals("말한 사람 미확인", heardMeta(null, null, null))
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
        assertEquals(Shell.RIDE, tripShell(parked = true, showsBrief = false, contentTab = false)) // 출발 전 C17(주차 중에도 함께 타는 중 틀)
        assertEquals(Shell.RIDE, tripShell(parked = false, showsBrief = false, contentTab = false)) // C17·C21
        assertEquals(Shell.TALK, tripShell(parked = false, showsBrief = false, contentTab = false, talk = true)) // C44(주행 중에도)
        assertEquals(28.dp, Shell.RIDE.padV); assertEquals(16.dp, Shell.RIDE.gap) // C17 2005:3267 py28·간격 16
        assertEquals(32.dp, Shell.TALK.padV); assertEquals(24.dp, Shell.TALK.gap) // C44 2019:1966 p32·간격 24
        assertEquals(Shell.PARKED, tripShell(parked = true, showsBrief = true, contentTab = false)) // C20·D19·최종 목적지: '주차 중  P'
        assertEquals(Shell.PARKED, tripShell(parked = true, showsBrief = false, contentTab = true)) // C22–C38
        assertEquals(Shell.RIDE, tripShell(parked = false, showsBrief = true, contentTab = false)) // 주행 중에는 브리핑이 없다
    }

    @Test fun seatCharacterFollowsSeatOrder() {
        assertEquals(0, seatCharacter(Person("a", "아빠", "ROW_1_LEFT", true)))
        assertEquals(4, seatCharacter(Person("b", "하은", "ROW_2_RIGHT", true)))
        assertEquals(0, seatCharacter(Person("c", "손님", "ROW_3_LEFT", true)))
    }

    @Test fun recordClockShowsMinutesSeconds() {
        assertEquals("00:00", recordClock(999))
        assertEquals("19:11", recordClock(1_151_000)) // C17 녹음 막대
        assertEquals("59:59", recordClock(3_599_000))
        assertEquals("1:02:03", recordClock(3_723_000)) // 한 시간부터 시:분:초
        assertEquals("00:00", recordClock(-5))
    }

    @Test fun waveFollowsVoiceMemosLevels() {
        // 0.1초 조각마다 첨두(가장 큰 |표본|)를 dBFS로: 16384 = 반 = −6.02 dB, −32768도 0 dB, 무음은 −120
        fun le(vararg v: Int) = ByteArray(v.size * 2).also { b -> v.forEachIndexed { i, x -> b[2 * i] = x.toByte(); b[2 * i + 1] = (x shr 8).toByte() } }
        assertEquals(-6.02f, chunkPeakDb(le(100, -16384, 200)), 0.01f)
        assertEquals(0f, chunkPeakDb(le(5, -32768)), 0.001f)
        assertEquals(-120f, chunkPeakDb(le(0, 0, 0)))
        // 막대 높이 = 10^(dB/24), −72 dB 밑은 버림
        assertEquals(1f, waveAmp(0f), 1e-6f)
        assertEquals(0.1f, waveAmp(-24f), 1e-6f)
        assertEquals(0.001f, waveAmp(-72f), 1e-6f)
        assertEquals(0f, waveAmp(-73f))
        assertEquals(1f, waveAmp(6f)) // 넘쳐도 1
    }

    @Test fun briefFoldsAsksIntoShortActions() {
        val trash = SharedTodo("n4", "마트", "쓰레기 정리하기", "pending", 0, emptyList(), "remember", listOf(TodoItem("쓰레기", null)), listOf("dad"), "쓰레기 정리하기")
        // C19 '화장실 가기 / 장보기 / 쓰레기 정리하기'
        assertEquals(listOf(NearRow(BriefIcon.RESTROOM, "화장실 가기"), NearRow(BriefIcon.CART, "장보기"), NearRow(BriefIcon.TRASH, "쓰레기 정리하기")),
            nearRows(F4Mock.martNear.take(2) + trash))
        // every thing to buy is one '장보기' row; at most three rows; anything else keeps its title with a mark by its words
        assertEquals(listOf(NearRow(BriefIcon.CART, "장보기")), nearRows(F4Mock.mart.drop(1)))
        assertEquals(listOf(NearRow(BriefIcon.RESTROOM, "화장실 가기"), NearRow(BriefIcon.COLD, "고기는 바로 냉장 보관"), NearRow(BriefIcon.LUGGAGE, "체크인하고 가방 내리기")),
            nearRows(F4Mock.lodge))
        val bags = SharedTodo("f3", "숙소", "짐과 쓰레기 챙기기", "pending", 0, emptyList(), "bring", listOf(TodoItem("짐", null), TodoItem("쓰레기", null)), listOf("dad"), "짐과 쓰레기 챙기기")
        assertEquals(listOf(NearRow(BriefIcon.TRASH, "짐과 쓰레기 챙기기")), nearRows(listOf(bags))) // finalNear 🗑
        val old = SharedTodo("o", "마트", "우유 꼭 사기", "pending", 0, emptyList()) // 이전 서버: 분류·제목 없음
        assertEquals(listOf(NearRow(BriefIcon.DRINK, "우유 꼭 사기")), nearRows(listOf(old))) // 도착 브리핑과 같은 그림(Twemoji 🥤)
        assertTrue(nearRows(F4Mock.mart + F4Mock.lodge).size <= 3)
    }

    @Test fun meIsTheDriverWithAProfile() {
        val dad = Person("a", "민준", "ROW_1_LEFT", true, profile = true)
        assertEquals(dad, mePerson(listOf(Person("b", "엄마", "ROW_1_RIGHT", true, profile = true), dad)))
        assertEquals(null, mePerson(listOf(Person("c", "손님", "ROW_1_LEFT", true)))) // 손님 운전자는 이 차의 계정이 아님
    }

    @Test fun seatFacesFollowTheGroupProfile() {
        assertEquals(R.drawable.char_glasses, faceRes(Person("a", "아빠", "ROW_1_LEFT", true, profile = true, character = "glasses"))) // 시안 C17 아빠
        assertEquals(R.drawable.char_cap, faceRes(Person("s", "서준", "ROW_2_LEFT", true, profile = true, character = "cap-small")))
        assertEquals(R.drawable.char_basic, faceRes(Person("g", "손님", "ROW_1_LEFT", true))) // 손님은 자리 순서
        assertEquals(R.drawable.char_cap, faceRes(Person("g", "손님", "ROW_1_RIGHT", true)))
    }
}
