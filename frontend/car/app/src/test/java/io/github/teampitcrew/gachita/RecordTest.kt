package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RecordTest {
    @Test fun clockShowsHoursMinutesSeconds() {
        assertEquals("00:00:00", recordClock(999))
        assertEquals("00:12:48", recordClock(768_000))
        assertEquals("01:02:03", recordClock(3_723_000))
    }

    @Test fun recordWordIsNullOnlyWhileTakingDown() {
        assertNull(recordWord(false, false, Handoff.State.OFF, Mic.ON, ""))
        assertEquals("마이크 꺼짐", recordWord(true, false, Handoff.State.OFF, Mic.ON, ""))
        assertEquals("Gleo가 끝나면 기록을 이어 가요", recordWord(false, false, Handoff.State.GLEO, Mic.ON, ""))
        assertEquals("마이크를 열지 못했어요", recordWord(false, false, Handoff.State.OFF, Mic.FAILED, ""))
        assertEquals("권한 없음", recordWord(false, false, Handoff.State.OFF, Mic.FAILED, "권한 없음"))
        assertEquals("쇼츠를 듣는 동안은 기록하지 않아요", recordWord(false, true, Handoff.State.OFF, Mic.ON, ""))
    }

    @Test fun briefFoldsAsksIntoShortActions() {
        // A D20 '화장실 가기 / 장보기 / 쓰레기 정리하기' from the demo asks
        assertEquals(listOf(BriefLine(BriefIcon.TOILET, "화장실 가기"), BriefLine(BriefIcon.CART, "장보기"), BriefLine(BriefIcon.TRASH, "쓰레기 정리하기")),
            briefLines(F4Mock.martBrief))
        // every thing to buy is one '장보기' row; at most three rows; anything else keeps its title
        val buys = F4Mock.mart.drop(1)
        assertEquals(listOf(BriefLine(BriefIcon.CART, "장보기")), briefLines(buys))
        assertEquals(listOf("화장실 가기", "고기는 바로 냉장 보관", "체크인하고 가방 내리기"), briefLines(F4Mock.lodge).map { it.text })
        val old = SharedTodo("o", "마트", "우유 꼭 사기", "pending", 0, emptyList()) // older server: no category, no title
        assertEquals(listOf(BriefLine(BriefIcon.DOT, "우유 꼭 사기")), briefLines(listOf(old)))
        assertTrue(briefLines(F4Mock.mart + F4Mock.lodge).size <= 3)
    }

    @Test fun gridHidesOnlyAnEmptyMiddleSeat() {
        val rows = seatRows(emptyList())
        val four = gridSeats(rows, F4Mock.people)
        assertTrue(four.flatten().none { it.name.endsWith("_CENTER") })
        assertEquals(rows.flatten().count { !it.name.endsWith("_CENTER") }, four.flatten().size)
        val middle = F4Mock.people.take(3) + Person("g", "할머니", "ROW_2_CENTER", true)
        assertTrue(gridSeats(rows, middle).flatten().any { it.name == "ROW_2_CENTER" })
    }
}
