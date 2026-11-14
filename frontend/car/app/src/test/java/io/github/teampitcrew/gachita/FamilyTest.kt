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
        assertEquals("동의와 목소리 등록 완료 / 다음 탑승부터 자동 기록 켜짐", readiness(DEMO_FAMILY.members))
    }
}
