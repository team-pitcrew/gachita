package io.github.teampitcrew.gachita

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar

class ContentsTest {
    private fun at(h: Int, m: Int) = Calendar.getInstance().apply { set(2026, 10, 14, h, m, 0); set(Calendar.MILLISECOND, 0) }.timeInMillis

    @Test fun parsesTripContentsAndOldServers() {
        val json = JSONObject("""{"code":"AB12","title":"강릉 가족 여행","createdAt":1,"members":[{"participantId":"a","name":"민준","character":"glasses","seat":"ROW_1_LEFT"},{"participantId":"b","name":"서준","character":"","seat":"ROW_2_LEFT"}],
            "places":[{"kind":"arrived","name":"숙소","at":${at(10, 28)}},{"kind":"start","name":"집","at":${at(9, 20)}}],"route":[[37.5,128.9,1],[37.8,129.1,2]],
            "contents":[{"id":"x","momentId":"m","title":"아빠보다 빠른 서준의 정답","seconds":32,"at":${at(9, 32)},"from":${at(9, 32) - 2000},"to":null,"lat":37.6,"lng":129.0,"place":"동해고속도로","kind":"device",
              "cast":[{"participantId":"a","name":"민준","character":"glasses"},{"participantId":"b","name":"서준","character":""}],
              "lines":[{"at":${at(9, 32) - 2000},"participantId":"a","name":"민준","text":"바다 언제 보여?"},{"at":${at(9, 32) + 4000},"participantId":"b","name":"서준","text":"아빠, 아까부터 바다 보이는데?"}],"url":"/api/trips/AB12/short-assets/x/file"},
              {"id":"y","momentId":"n","title":"옛 서버","seconds":29,"at":${at(10, 22)},"lat":null,"lng":null,"place":null,"kind":"generated","url":"/api/trips/AB12/short-generations/y/file"}]}""")
        val trip = parseContentTrip(json)
        assertEquals(listOf("start", "arrived"), trip.places.map { it.kind })
        assertEquals("ROW_2_LEFT", trip.contents[0].cast[1].seat)
        assertEquals(emptyList<ContentLine>(), trip.contents[1].cast.let { emptyList<ContentLine>() })
        assertNull(trip.contents[1].lat)
        assertEquals("09:20 출발 → 10:28 숙소", contentTripLine(trip.places))
        assertEquals("바다 언제 보여?", contentLineAt(trip.contents[0], 0.0)!!.text)
        assertEquals("서준", contentLineAt(trip.contents[0], 6.5)!!.name)
        assertNull(contentLineAt(trip.contents[1], 3.0))
    }

    @Test fun mockLabelsAndPlaces() {
        val places = listOf(ContentPlace("start", "집", at(9, 20)), ContentPlace("stop", "동해고속도로", at(9, 30)), ContentPlace("approaching", "하나로마트", at(9, 50)),
            ContentPlace("arrived", "하나로마트", at(9, 55)), ContentPlace("arrived", "강릉 숙소", at(10, 28)))
        assertEquals("09:20 출발 → 동해고속도로 → 하나로마트 → 10:28 강릉 숙소", contentTripLine(places))
        assertEquals("동해고속도로 → 하나로마트 → 강릉 숙소", contentPlaceChain(places))
        assertEquals("", contentTripLine(emptyList()))
        val item = ContentItem("x", "제목", 32.0, 0, null, null, null, null, "device", listOf(ContentPerson("a", "민준", ""), ContentPerson("b", "서준", "")), emptyList(), "/u")
        assertEquals("민준과\n서준의 이야기", contentHeadline(item))
        assertEquals("캐릭터 자막형", contentStyle(item))
        assertEquals("가족 대화형", contentStyle(item.copy(kind = "generated")))
        assertEquals("아빠보다 빠른 서…", contentPinLabel("아빠보다 빠른 서준의 정답"))
        assertEquals("01:12", contentClock(72.4))
    }

    @Test fun projectsNorthUpInsideBox() {
        val p = contentProjector(listOf(37.5 to 128.9, 37.8 to 129.1), 800f, 400f, 40f)!!
        val a = p(37.5 to 128.9); val b = p(37.8 to 129.1)
        assertTrue(b.y < a.y && b.x > a.x)
        for (o in listOf(a, b)) assertTrue(o.x in 0f..800f && o.y in 0f..400f)
        assertNull(contentProjector(emptyList(), 800f, 400f, 40f))
    }
}
