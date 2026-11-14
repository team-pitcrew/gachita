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
        assertNull(todoOf("카페에서 먹은 피자")) // '자'로 끝나도 권하는 말이 아님
        assertEquals("마트", todoOf("집에서 나오기 전에 마트에서 사자")!!.first) // 마지막 '에서'의 장소
    }

    @Test fun arrivalByNextStop() {
        assertTrue(arrivedAt("마트", "이마트 강릉점"))
        assertFalse(arrivedAt("마트", "용인휴게소 강릉방향")) // 마트로 가는 길의 휴게소에 선 것
        assertFalse(arrivedAt("마트", null))
    }

    @Test fun storeKeepsOpenAndDone() {
        val dir = Files.createTempDirectory("todos").toFile()
        val box = Todos(dir, "T", TEST_SEAL)
        val a = box.add("마트", "마트에서 우유랑 간식 사자")!!
        box.add("마트", "마트에서 물도 사야 돼")
        box.add("숙소", "숙소에서 가방 꺼내자")
        box.done(a.id)
        assertEquals(listOf("마트에서 물도 사야 돼"), box.open("마트").map { it.text }) // 완료한 것은 다음 알림에서 빠진다
        assertEquals(2, box.open().size)
        assertNull(box.add("마트", "마트에서 물도 사야 돼")) // 같은 말은 다시 모으지 않는다(TTS가 마이크로 되돌아와도)
        assertNull(box.add("마트", "마트에서 우유랑 간식 사자")) // 완료한 것도 되살아나지 않는다
        val again = Todos(dir, "T", TEST_SEAL) // 앱을 다시 켜도 이어진다
        assertEquals(box.items, again.items)
        assertEquals(4L, again.add("마트", "마트에서 빵 사자")!!.id)
        assertEquals("마트에 도착했어요. 할 일 1건. 마트에서 물도 사야 돼", briefingLine("마트", box.open("마트")))
    }

    // 서버 시험(backend/api/arrival-vectors.test.js)이 만든 파일. 도착 판정을 한쪽만 고치면 여기서 걸린다(T144).
    @Test fun sameArrivalAsServer() {
        val cases = org.json.JSONObject(java.io.File("../../../backend/api/arrival-vectors.json").readText()).getJSONArray("cases")
        assertEquals(7, cases.length())
        for (k in 0 until cases.length()) {
            val c = cases.getJSONObject(k)
            val i = c.getJSONObject("input")
            val p = i.getJSONObject("place").let { Place(it.getDouble("lat"), it.getDouble("lng"), it.getString("name")) }
            val at = i.getJSONObject("position")
            val arrival = VehicleArrival(p, at.getDouble("lat"), at.getDouble("lng"), i.getLong("observedAt"))
            val items = c.getJSONArray("items").let { a -> (0 until a.length()).map { a.getJSONObject(it) } }
                .map { SharedTodo(it.getString("id"), it.getString("place"), "", it.getString("status"), 0, emptyList()) }
            val e = c.getJSONObject("expected")
            val got = pickArrival(arrival, i.getBoolean("parked"), items, 1, c.getLong("now"))
            val name = c.getString("name")
            assertEquals(name, e.getBoolean("eligible"), got.eligible)
            assertEquals(name, if (e.isNull("reason")) null else e.getString("reason"), got.reason)
            assertEquals(name, e.getInt("distanceMeters"), Math.round(arrivalMeters(p, arrival.lat, arrival.lng)).toInt())
            assertEquals(name, e.getJSONArray("items").let { a -> (0 until a.length()).map(a::getString) }, got.items.map { it.id })
        }
    }
}

