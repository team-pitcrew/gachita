package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** 시연 팩(DemoPack.kt) 읽기·확인과 기존 화면 값으로 바꾸기. 값은 모두 지어낸 것이다. */
class DemoPackTest {
    private val scene = """{"id":"s1","from":300,"to":330,"title":"바다 가자","quote":"바다 어때?","who":"b","video":"s1.mp4","cover":"s1.png","seconds":31.5,"lat":37.45,"lng":127.05}"""
    private fun manifest(people: String = """{"id":"a","name":"가람","seat":"ROW_1_LEFT","character":"glasses"},{"id":"b","name":"나래","seat":"ROW_2_RIGHT","character":"cap"}""",
        lines: String = """{"at":310,"who":"b","text":"바다 어때?"},{"at":20,"who":"a","text":"어디로 갈까?"}""", scenes: String = scene, extra: String = "") =
        """{"version":1,"title":"주말 나들이","group":"나들이 모임","seconds":1200,$extra"people":[$people],"lines":[$lines],
            "route":[{"lat":37.5,"lng":127.0,"name":"출발지"},{"lat":37.45,"lng":127.05},{"lat":37.4,"lng":127.1,"name":"도착지"}],"scenes":[$scenes]}"""
    private val live = Trip("AB12", "실제 여행", "ended", listOf(Person("x", "다른 이름", "ROW_1_LEFT", true)), 0, 3, generation = 2, createdAt = 1_000_000)

    @Test fun readsPackAndFillsTheScreens() {
        val pack = parseDemoPack(manifest())
        // 실제 계정과 이름이 달라도 화면은 팩의 사람·제목을 쓰고, 여행 코드·세대는 그대로
        val trip = pack.trip(live)
        assertEquals(listOf("가람", "나래"), trip.people.map { it.name })
        assertEquals("AB12" to 2, trip.code to trip.generation)
        assertEquals("주말 나들이", trip.title)
        assertEquals("a", pack.driver)
        // 대화 기록: 시각 순, 모든 줄에 화자(미확인 없음), 시각은 지금 여행을 만든 때부터
        val said = pack.transcript(trip)
        assertEquals(listOf("어디로 갈까?", "바다 어때?"), said.map { it.text })
        assertTrue(said.all { l -> trip.people.any { it.id == l.participantId } })
        assertEquals(1_000_000L + 20_000, said[0].at)
        assertEquals(listOf("출발지", "출발지", "도착지"), pack.tripPlaces(trip).map { it.name })
        // 추천 장면: 팩의 장면 그대로
        val pick = pack.picks(trip).single()
        assertEquals(Triple(1, "바다 가자", "“바다 어때?”"), Triple(pick.number, pick.title, pick.quote))
        assertEquals(1_000_000L + 300_000 to 1_000_000L + 330_000, pick.from to pick.to)
        // 콘텐츠 기록: 쇼츠·경로·출발과 도착, 장면 id가 momentId
        val contents = pack.contentTrip(trip)
        assertEquals("나들이 모임", contents.crew)
        assertEquals(listOf("origin", "start", "arrived"), contents.places.map { it.kind }) // origin: 경로 요약에 출발지 이름을 넣는 줄
        assertEquals(1_000_000L + 1_200_000, contents.places.last().at)
        assertEquals(3, contents.route.size)
        val item = contents.contents.single()
        assertEquals("s1" to "s1", item.id to item.momentId)
        assertEquals("도착지 가는 길", item.place)
        assertEquals("나래", contentQuote(item)!!.name)
        assertEquals(37.45 to 127.05, contentSpot(item, contents))
        assertEquals("도착지", pack.arrival)
    }

    @Test fun startedAtPinsTheClock() {
        val pack = parseDemoPack(manifest(extra = """"startedAt":5000000,"""))
        assertEquals(5_000_000L + 20_000, pack.transcript(pack.trip(live))[0].at)
        assertEquals(5_000_000L, pack.trip(live).createdAt)
    }

    @Test fun heardLinesFollowTheTalkButSkipLongSilence() {
        val lines = listOf(DemoLine(20.0, "a", "하나"), DemoLine(22.0, "b", "둘"), DemoLine(22.1, "a", "셋"), DemoLine(300.0, "b", "넷"))
        assertEquals(listOf(1500L, 2000L, 800L, 3500L), lines.indices.map { demoGapMs(lines, it) })
    }

    @Test fun rejectsBrokenPacks() {
        fun bad(json: String) { assertThrows(IllegalArgumentException::class.java) { parseDemoPack(json) } }
        bad(manifest().replace("\"version\":1", "\"version\":2"))
        bad(manifest(lines = """{"at":20,"who":"zz","text":"누구?"}""")) // 화자가 팩에 없는 줄(미확인)
        bad(manifest(lines = """{"at":2000,"who":"a","text":"여행 밖"}"""))
        bad(manifest(people = """{"id":"a","name":"가람","seat":"TRUNK","character":""}"""))
        bad(manifest(scenes = scene.replace("s1.mp4", "../secret.mp4"))) // 팩 폴더 밖 파일
        bad(manifest(scenes = scene.replace("\"to\":330", "\"to\":200")))
        bad(manifest(scenes = ""))
        assertNull(parseDemoPack(manifest()).startedAt)
    }
}
