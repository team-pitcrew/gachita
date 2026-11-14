package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ArrivalGroupTest {
    private val mom = Person("p1", "엄마", "ROW_1_RIGHT", true)
    private val haeun = Person("p2", "하은", "ROW_2_RIGHT", true)
    private val people = listOf(mom, haeun)

    private fun todo(id: String, status: String = "pending", vararg sources: Pair<Long, String?>) =
        SharedTodo(id, "마트", "마트에서 $id 사자", status, 0, sources.map { (at, who) -> SharedTodoSource("car", at, at, "말", "말", who) })

    @Test fun firstConfirmedSpeakerOwnsTheAsk() {
        assertEquals(haeun, askSpeaker(todo("a", "pending", 5L to "p2", 9L to "p1"), people))
        assertEquals(mom, askSpeaker(todo("b", "pending", 1L to "gone", 3L to "p1"), people)) // 여행에 없는 참가자는 건너뜀
        assertNull(askSpeaker(todo("c", "pending", 1L to null), people))
    }

    @Test fun groupsByPersonOpenFirstUnknownLast() {
        val items = listOf(
            todo("done", "done", 1L to "p1"),
            todo("toilet", "pending", 2L to "p2"),
            todo("meat", "pending", 3L to "p1"),
            todo("who", "pending", 4L to null),
            todo("fruit", "pending", 5L to "p1"),
        )
        val groups = asksByPerson(items, people)
        assertEquals(listOf(haeun, mom, null), groups.map { it.person })
        assertEquals(listOf("toilet"), groups[0].items.map { it.id })
        assertEquals(listOf("meat", "fruit", "done"), groups[1].items.map { it.id }) // 미완료 먼저, 서버 순서 유지
        assertEquals(listOf("who"), groups[2].items.map { it.id })
    }
}
