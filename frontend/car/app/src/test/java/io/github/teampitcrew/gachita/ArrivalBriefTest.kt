package io.github.teampitcrew.gachita

import io.github.teampitcrew.gachita.BriefIcon.CART
import io.github.teampitcrew.gachita.BriefIcon.COLD
import io.github.teampitcrew.gachita.BriefIcon.DRINK
import io.github.teampitcrew.gachita.BriefIcon.FRUIT
import io.github.teampitcrew.gachita.BriefIcon.LUGGAGE
import io.github.teampitcrew.gachita.BriefIcon.MEAT
import io.github.teampitcrew.gachita.BriefIcon.RESTROOM
import io.github.teampitcrew.gachita.BriefIcon.SNACK
import io.github.teampitcrew.gachita.BriefIcon.TRASH
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** F4(T141): 도착 전·도착 브리핑의 행동 항목. 서버 할 일(place-rules-v2)의 칸을 그대로 쓰고 지어내지 않는다. */
class ArrivalBriefTest {
    private val people = F4Mock.people
    private fun List<BriefRow>.noId() = map { it.copy(id = "") }

    @Test fun demoNotesReplaceTheRequesterLineOnlyWhenGiven() {
        val rows = briefRows(F4Mock.lodge, people)
        assertEquals(listOf("하은이 요청"), rows.first.map { it.who })
        assertEquals(listOf("하은이와 함께 1층 화장실"), rows.withDetails(F4Mock.lodgeDetails).first.map { it.who })
        assertEquals(listOf("예약자 민준 / 트렁크의 가족 가방"), rows.withDetails(F4Mock.lodgeDetails).bring.map { it.who })
        assertEquals(rows, rows.withDetails(emptyMap()))
    }

    @Test fun iconByNameThenCategory() {
        assertEquals(listOf(MEAT, FRUIT, SNACK, DRINK, DRINK, RESTROOM, COLD, LUGGAGE, TRASH),
            listOf("삼겹살", "귤", "젤리", "탄산수", "물", "화장실 먼저 다녀오기", "고기는 바로 냉장 보관", "가방", "쓰레기 정리하기").map { iconOf(it, null) })
        assertEquals(CART, iconOf("물티슈", "buy"))
        assertEquals(listOf(RESTROOM, CART, COLD, LUGGAGE), listOf("first", "buy", "remember", "bring").map { iconOf("체크인", it) })
    }

    @Test fun whoAskedUsesConfirmedSpeakersOnly() {
        assertEquals("하은이 요청", whoAsked(F4Mock.mart[0], people))
        assertEquals("엄마 요청", whoAsked(F4Mock.mart[1], people))
        assertEquals("엄마·서준이 요청", whoAsked(F4Mock.mart[1].copy(requestedBy = listOf("mom", "seojun")), people))
        assertEquals("", whoAsked(F4Mock.mart[1].copy(requestedBy = emptyList()), people))
        assertEquals("", whoAsked(F4Mock.mart[1].copy(requestedBy = listOf("gone")), people))
    }

    @Test fun waypointGroupsFirstAndOneRowPerGood() {
        val rows = briefRows(F4Mock.mart, people).let { r -> BriefRows(r.first.noId(), r.buy.noId(), r.remember.noId(), r.bring.noId()) }
        assertEquals(listOf(BriefRow(RESTROOM, "화장실 먼저 다녀오기", "하은이 요청", "")), rows.first)
        assertEquals(listOf(BriefRow(MEAT, "삼겹살", "엄마 요청", "600g"), BriefRow(FRUIT, "귤", "엄마 요청", "1봉지"),
            BriefRow(SNACK, "젤리", "서준이 요청", "1봉지"), BriefRow(DRINK, "탄산수", "아빠 요청", "2병")), rows.buy)
        assertEquals("계속", arrivalButton(false)) // C20·D19 단추
        assertEquals("먼저 할 일과 살 것을 모았어요", arrivalSub(false))
    }

    @Test fun finalDestinationHasFirstRememberBring() {
        val rows = briefRows(F4Mock.lodge, people).let { r -> BriefRows(r.first.noId(), r.buy.noId(), r.remember.noId(), r.bring.noId()) }
        assertEquals(listOf("화장실 먼저 다녀오기"), rows.first.map { it.name })
        assertEquals(listOf(BriefRow(COLD, "고기는 바로 냉장 보관", "엄마 요청", "")), rows.remember)
        assertEquals(listOf(BriefRow(LUGGAGE, "체크인하고 가방 내리기", "아빠 요청", "")), rows.bring)
        assertEquals("여행 마치고 기록 보기", arrivalButton(true))
        assertEquals("내리기 전, 할 일과 챙길 것", arrivalSub(true)) // finalBrief 2043:1890
    }

    @Test fun olderServerAskIsOneRememberRow() {
        val old = SharedTodo("x", "마트", "마트에서 우유 사자", "pending", 0, emptyList())
        assertEquals(listOf("우유 사자"), briefRows(listOf(old), people).remember.map { it.name })
        assertTrue(briefRows(listOf(old.copy(status = "done")), people).isEmpty)
    }

    @Test fun nearLinesFollowTheDesign() {
        assertEquals("하은 화장실 / 고기와 과일 / 간식과 음료 챙기기", nearLine(F4Mock.martNear, people)) // C19 화면 글
        assertEquals("하은 화장실 / 엄마 냉장 보관 / 아빠 체크인과 가방 챙기기", nearLine(F4Mock.lodge, people)) // finalNear
        assertEquals("삼겹살과 귤", andWords(listOf("삼겹살", "귤")))
        assertEquals("고기, 과일과 음료", andWords(listOf("고기", "과일", "음료")))
    }

    @Test fun approachIsFiveMinutesOrLessRoundedUp() {
        assertEquals(Approach("T", "하나로마트", 3, 170), approach("T", " 하나로마트 ", 170))
        assertEquals(1, approach("T", "강릉 숙소", 1, final = true)!!.minutes)
        assertTrue(approach("T", "강릉 숙소", 60, final = true)!!.final)
        assertNull(approach("T", "하나로마트", 301))
        assertNull(approach("T", "하나로마트", 0)) // 내비가 남은 시간을 모름
        assertNull(approach("T", " ", 100))
        assertEquals(listOf("m1", "m2"), placeAsks("하나로마트", F4Mock.mart.take(2)).map { it.id }) // '마트'는 '하나로마트'에 들어 있음
    }

    @Test fun parsesActionItemFieldsFromTheServer() {
        val t = sharedTodo(JSONObject("""{"id":"a","place":"마트","text":"마트에서 삼겹살 600g이랑 귤 한 봉지 사 가자","status":"pending","version":0,
            "sources":[{"device":"car","seq":1,"at":1,"text":"t","displayText":"t","participantId":"mom"}],
            "category":"buy","title":"삼겹살 600g이랑 귤 한 봉지 사 가기","items":[{"name":"삼겹살","qty":"600g"},{"name":"귤","qty":null}],"requestedBy":["mom","mom"],"method":"place-rules-v2"}"""))
        assertEquals("buy", t.category)
        assertEquals(listOf(TodoItem("삼겹살", "600g"), TodoItem("귤", null)), t.items)
        assertEquals(listOf("mom"), t.requestedBy)
        assertEquals("삼겹살 600g이랑 귤 한 봉지 사 가기", t.title)
        val old = sharedTodo(JSONObject("""{"id":"b","place":"마트","text":"마트에서 우유 사자","status":"pending","version":0,"sources":[]}"""))
        assertNull(old.category); assertNull(old.title); assertEquals(emptyList<TodoItem>(), old.items)
    }
}
