package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DriveTest {
    private fun status(recording: Boolean = true, muted: Boolean = false, handoff: Handoff.State = Handoff.State.OFF, mic: Mic = Mic.ON,
                       offPending: Boolean = false, waiting: Boolean = false, inPark: Boolean = true, waitingFor: List<String> = emptyList()) =
        driveStatus(recording, muted, false, handoff, mic, "", offPending, waiting, inPark, waitingFor)

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

    @Test fun approachingWithinFiveMinutes() {
        assertEquals(Approach("T1", "하나로마트 강릉점", 3), approach("T1", " 하나로마트 강릉점 ", 150))
        assertEquals(5, approach("T1", "마트", APPROACH_SECONDS)!!.minutes)
        assertEquals(1, approach("T1", "마트", 20)!!.minutes)
        assertNull(approach("T1", "마트", APPROACH_SECONDS + 1))
        assertNull(approach("T1", "마트", 0)) // 내비가 남은 시간을 모름(안내 중 아님)
        assertNull(approach("T1", "", 120))
        assertNull(approach("T1", null, 120))
        assertNull(approach("T1", "마트", null))
    }

    private fun todo(id: String, place: String, text: String, status: String = "pending", who: String? = null, at: Long = 1) =
        SharedTodo(id, place, text, status, 0, listOf(SharedTodoSource("car", at, at, text, text, who)))

    @Test fun placeAsksUseTheServerPlaceRule() {
        val items = listOf(todo("a", "마트", "마트에서 고기랑 과일도 사 가자"), todo("b", "숙소", "숙소에서는 가방부터 꺼내자"), todo("c", "마트", "마트에서 물도 사자", "done"))
        assertEquals(listOf("a"), placeAsks("하나로마트 강릉점", items).map { it.id })
        assertTrue(placeAsks("용인휴게소 강릉방향", items).isEmpty())
    }

    @Test fun shortAskDropsThePlacePhrase() {
        assertEquals("고기랑 과일도 사 가자", shortAsk(todo("a", "마트", "마트에서 고기랑 과일도 사 가자")))
        assertEquals("가방부터 꺼내자", shortAsk(todo("b", "숙소", "숙소에서는 가방부터 꺼내자")))
        assertEquals("사자", shortAsk(todo("c", "마트", "집에서 나오기 전에 마트에서 사자")))
        assertEquals("마트 들러서 사자", shortAsk(todo("d", "마트", "마트 들러서 사자")))
    }

    @Test fun nearLineNamesConfirmedSpeakersOnly() {
        val people = listOf(Person("p1", "엄마", "ROW_1_RIGHT", true), Person("p2", "하은", "ROW_2_RIGHT", true))
        val asks = listOf(todo("a", "마트", "마트에서 고기랑 과일도 사 가자", who = "p1"), todo("b", "마트", "마트에서 젤리도 사자", who = "x"))
        assertEquals("엄마 고기랑 과일도 사 가자 / 젤리도 사자", nearLine(asks, people))
    }

    @Test fun seatCharacterFollowsSeatOrder() {
        assertEquals(0, seatCharacter(Person("a", "아빠", "ROW_1_LEFT", true)))
        assertEquals(4, seatCharacter(Person("b", "하은", "ROW_2_RIGHT", true)))
        assertEquals(0, seatCharacter(Person("c", "손님", "ROW_3_LEFT", true)))
    }
}
