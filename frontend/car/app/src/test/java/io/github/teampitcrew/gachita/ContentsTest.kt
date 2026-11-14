package io.github.teampitcrew.gachita

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
        assertEquals("아빠보다 빠른 정답", contentPinLabel("아빠보다 빠른 서준의 정답", listOf("서준")))
        assertEquals("아빠보다 빠른…", contentPinLabel("아빠보다 빠른 서준의 정답"))
        assertEquals("내일도 같이 타면…", contentPinLabel("내일도 같이 타면 안 돼?", listOf("하은")))
        assertEquals("01:12", contentClock(72.4))
    }

    @Test fun projectsNorthUpInsideBox() {
        val p = contentProjector(listOf(37.5 to 128.9, 37.8 to 129.1), 800f, 400f, 40f)!!
        val a = p(37.5 to 128.9); val b = p(37.8 to 129.1)
        assertTrue(b.y < a.y && b.x > a.x)
        for (o in listOf(a, b)) assertTrue(o.x in 0f..800f && o.y in 0f..400f)
        assertNull(contentProjector(emptyList(), 800f, 400f, 40f))
    }

    @Test
    fun `moment place reads the way to the next place after a stop`() {
        val min = 60_000L
        val log = listOf(ContentPlace("start", "집", 0), ContentPlace("stop", "하나로마트", 0), ContentPlace("destination", "강릉 숙소", 0),
            ContentPlace("approaching", "하나로마트", 35 * min), ContentPlace("arrived", "하나로마트", 40 * min))
        assertEquals("동해고속도로", contentWay(12 * min, "동해고속도로", log))
        assertEquals("하나로마트 가는 길", contentWay(37 * min, "하나로마트", log))
        assertEquals("강릉 숙소 가는 길", contentWay(62 * min, "하나로마트", log))
        val done = log + ContentPlace("arrived", "강릉 숙소", 68 * min)
        assertEquals("강릉 숙소 가는 길", contentWay(62 * min, "하나로마트", done))
        assertEquals("강릉 숙소", contentWay(70 * min, "강릉 숙소", done))
        assertEquals(null, contentWay(0, null, emptyList()))
    }

    @Test
    fun `v3 cover, title and clock helpers`() {
        assertEquals("아빠보다 빠른\n서준의 정답", contentTwoLines("아빠보다 빠른 서준의 정답"))
        assertEquals("내일도 같이\n타면 안 돼?", contentTwoLines("내일도 같이 타면 안 돼?"))
        assertEquals("짧은 제목", contentTwoLines("짧은 제목"))
        assertEquals("강릉\n가족 여행", contentTripTitleLines("강릉 가족 여행"))
        val item = ContentItem("x", "제목", 32.0, 10_000, 8_000, null, null, null, "device", emptyList(),
            listOf(ContentLine(8_000, "a", "아빠", "바다 언제 보여?"), ContentLine(10_500, "b", "서준", "아빠, 아까부터 바다 보이는데?"), ContentLine(14_000, "a", "아빠", "어? 진짜네!")), "/u")
        assertEquals("서준", contentQuote(item)!!.name)
        assertNull(contentQuote(item.copy(lines = emptyList())))
        assertEquals("0:32", contentShortClock(32.4))
        assertEquals("1:05", contentShortClock(65.0))
        assertEquals("11.14", contentCoverDate(at(9, 32)))
        // 시안 갤러리의 두 장면: tint-2, tint-3(CarTints 1, 2).
        assertEquals(listOf(1, 2, 0, 3, 4, 1), (0..5).map { contentTint(it) })
        assertEquals(4, contentTint(-1)) // 목록에 없는 장면(-1)도 범위 안
    }

    @Test
    fun `trip range prefers places, then server times, then contents`() {
        val trip = ContentTrip("AB", "강릉 가족 여행", 1, emptyList(), listOf(ContentPlace("start", "출발", 100), ContentPlace("arrived", "강릉 숙소", 900)), emptyList(), emptyList())
        assertEquals(100L to 900L, contentTripRange(trip))
        assertEquals(5L to 7L, contentTripRange(trip.copy(places = emptyList(), startedAt = 5, endedAt = 7)))
        assertEquals(1L to 1L, contentTripRange(trip.copy(places = emptyList())))
        val json = JSONObject("""{"code":"AB","title":"t","createdAt":1,"startedAt":5,"endedAt":null,"members":[],"places":[],"route":[],"contents":[]}""")
        assertEquals(5L, parseContentTrip(json).startedAt)
        assertNull(parseContentTrip(json).endedAt)
    }

    @Test
    fun `bundled OpenStreetMap projection and the schematic fallback`() {
        assertTrue(contentOnBundledMap(listOf(37.7519 to 128.8761, 37.7955 to 128.9050)))
        assertFalse(contentOnBundledMap(listOf(37.5 to 127.0, 37.6 to 127.1)))
        assertFalse(contentOnBundledMap(emptyList()))
        val p = contentOsmProjector(1080f, 660f)
        val nw = p(OSM_NORTH to OSM_WEST); val se = p(OSM_SOUTH to OSM_EAST)
        assertEquals(0f, nw.x, 0.5f); assertEquals(-48f, nw.y, 0.5f) // 1200×840을 1080 폭에 맞추면 위아래 48씩 잘림(시안 object-cover)
        assertEquals(1080f, se.x, 0.5f); assertEquals(708f, se.y, 0.5f)
    }
}
