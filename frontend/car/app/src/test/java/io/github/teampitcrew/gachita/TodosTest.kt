package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class TodosTest {
    @Test fun placeAndTask() {
        assertEquals("마트" to "마트에서 우유랑 간식 사자", todoOf("마트에서 우유랑 간식 사자"))
        assertEquals("마트" to "마트에서 물도 사야 돼", todoOf("마트에서 물도 사야 돼."))
        assertEquals("마트", todoOf("마트에서 물도 사야 되")!!.first) // 에뮬레이터 STT가 실제로 적은 꼴
        assertEquals("숙소", todoOf("숙소에서는 아이 가방부터 꺼내자")!!.first)
        assertNull(todoOf("바다는 왜 짜?"))
        assertNull(todoOf("마트에서 뭐 샀어?")) // 할 일로 끝나지 않음
        assertNull(todoOf("응, 다음 휴게소 가자")) // '에서'가 없음
    }

    @Test fun arrivalByNaviName() {
        assertTrue(arrivedAt("마트", listOf("강릉역", "이마트 강릉점")))
        assertFalse(arrivedAt("마트", listOf("강릉역", "용인휴게소 강릉방향")))
        assertFalse(arrivedAt("마트", emptyList()))
    }

    @Test fun storeKeepsOpenAndDone() {
        val dir = Files.createTempDirectory("todos").toFile()
        val box = Todos(dir, "T")
        val a = box.add("마트", "마트에서 우유랑 간식 사자")
        box.add("마트", "마트에서 물도 사야 돼")
        box.add("숙소", "숙소에서 가방 꺼내자")
        box.done(a.id)
        assertEquals(listOf("마트에서 물도 사야 돼"), box.open("마트").map { it.text }) // 완료한 것은 다음 알림에서 빠진다
        assertEquals(2, box.open().size)
        val again = Todos(dir, "T") // 앱을 다시 켜도 이어진다
        assertEquals(box.items, again.items)
        assertEquals(4L, again.add("마트", "마트에서 빵 사자").id)
        assertEquals("마트에 도착했어요. 할 일 1건. 마트에서 물도 사야 돼", briefingLine("마트", box.open("마트")))
    }
}
