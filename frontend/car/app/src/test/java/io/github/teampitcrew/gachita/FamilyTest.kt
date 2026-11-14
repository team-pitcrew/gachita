package io.github.teampitcrew.gachita

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FamilyTest {
    // backend/api가 돌려주는 모양(openapi.yaml의 Group, T133)
    private val json = """
        {"id":"g1","name":"우리 가족","kind":"family","ownerId":"dad",
         "members":[
          {"profileId":"dad","name":"아빠","character":"glasses","hasPhoto":false,"hasVoice":true,"consent":true,"role":"owner","seat":"ROW_1_LEFT","pending":false},
          {"profileId":"son","name":"서준","character":"cap","hasPhoto":false,"hasVoice":false,"consent":true,"role":"child","seat":"ROW_2_LEFT","pending":false,"guardianId":"dad"},
          {"profileId":"girl","name":"하은","character":"basic-small","hasPhoto":false,"hasVoice":true,"consent":false,"role":"child","seat":null,"pending":false,"guardianId":"dad"}],
         "invite":{"code":"FAMILY-2714","expiresAt":1,"url":"/?group=FAMILY-2714"}}
    """.trimIndent()

    @Test fun `그룹 응답을 읽고 자리 없는 구성원은 null`() {
        val g = parseGroup(JSONObject(json))
        assertEquals("FAMILY-2714", g.invite?.code)
        assertEquals("/?group=FAMILY-2714", g.invite?.url)
        assertEquals(listOf("owner", "child", "child"), g.members.map { it.role })
        assertNull(g.members[2].seat)
    }

    @Test fun `좌석 맞바꾸기는 두 사람만 바꾸고 자리 없는 사람과 바꾸면 자리를 넘긴다`() {
        val g = parseGroup(JSONObject(json))
        assertEquals(listOf("ROW_2_LEFT", "ROW_1_LEFT", null), swapSeats(g.members, "dad", "son").map { it.seat })
        assertEquals(listOf("ROW_1_LEFT", null, "ROW_2_LEFT"), swapSeats(g.members, "son", "girl").map { it.seat })
    }

    @Test fun `우리 가족 아래 줄은 동의와 목소리 수를 센다`() {
        val g = parseGroup(JSONObject(json))
        assertEquals("녹음 동의 2/3명 / 목소리 등록 2/3명", readiness(g.members))
        assertEquals("녹음 동의 4명 완료 / 목소리 등록 4명 완료", readiness(DEMO_FAMILY.members))
    }

    @Test fun `자리 없는 구성원을 빈자리에 앉히고 앉은 사람과는 맞바꾼다(차에서 만든 아이·초대 성인·동승 그룹)`() {
        val g = parseGroup(JSONObject(json)) // 하은은 자리 없음
        val sit = seatMove(g.members, SeatPick("girl", null), SeatPick(null, "ROW_2_RIGHT"))!!
        assertEquals(listOf("ROW_1_LEFT", "ROW_2_LEFT", "ROW_2_RIGHT"), sit.first.map { it.seat })
        assertEquals("하은을 뒤 오른쪽에 앉혔어요.", sit.second)
        // 빈자리를 먼저 눌러도 같다
        assertEquals(sit.first, seatMove(g.members, SeatPick(null, "ROW_2_RIGHT"), SeatPick("girl", null))!!.first)
        // 자리 없는 사람 → 앉은 사람: 맞바꿔 앉았던 사람이 자리 없음으로
        val swap = seatMove(g.members, SeatPick("girl", null), SeatPick("son", "ROW_2_LEFT"))!!
        assertEquals(listOf("ROW_1_LEFT", null, "ROW_2_LEFT"), swap.first.map { it.seat })
        assertEquals("하은과 서준의 자리 위치를 바꿨어요.", swap.second)
        // 앉은 사람 → 다른 빈자리: 옮김
        assertEquals(listOf("ROW_1_RIGHT", "ROW_2_LEFT", null), seatMove(g.members, SeatPick("dad", "ROW_1_LEFT"), SeatPick(null, "ROW_1_RIGHT"))!!.first.map { it.seat })
        assertNull(seatMove(g.members, SeatPick(null, "ROW_1_RIGHT"), SeatPick(null, "ROW_2_RIGHT")))
        assertNull(seatMove(g.members, SeatPick("son", "ROW_2_LEFT"), SeatPick("son", "ROW_2_LEFT")))
    }

    @Test fun `저장할 자리는 저장한 그룹과 다른 것만, 같으면 없다`() {
        val g = parseGroup(JSONObject(json))
        assertEquals(emptyMap<String, String?>(), seatChanges(g.members, g.members))
        val moved = placeSeat(g.members, "girl", "ROW_1_LEFT") // 아빠 자리로: 아빠는 하은의 원래 자리(없음)로
        assertEquals(mapOf("dad" to null, "girl" to "ROW_1_LEFT"), seatChanges(g.members, moved))
    }
}
