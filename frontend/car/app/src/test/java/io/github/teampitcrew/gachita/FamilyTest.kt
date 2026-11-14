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

    @Test fun `자리 없는 사람은 빈자리에 앉히고, 앉은 사람끼리만 맞바꾼다`() {
        val g = parseGroup(JSONObject(json)) // 아빠 운전석, 서준 뒤 왼쪽, 하은 자리 없음
        val sit = seatPick(g.members, SeatPick("girl", null), SeatPick(null, "ROW_2_RIGHT"))
        assertEquals(listOf("ROW_1_LEFT", "ROW_2_LEFT", "ROW_2_RIGHT"), sit.members!!.map { it.seat })
        assertEquals("하은을 뒤 오른쪽에 앉혔어요.", sit.note)
        assertEquals("서준과 하은의 뒷자리 위치를 바꿨어요.", seatPick(sit.members!!, SeatPick("son", "ROW_2_LEFT"), SeatPick("girl", "ROW_2_RIGHT")).note)
        val swap = seatPick(g.members, SeatPick("dad", "ROW_1_LEFT"), SeatPick("son", "ROW_2_LEFT"))
        assertEquals(listOf("ROW_2_LEFT", "ROW_1_LEFT", null), swap.members!!.map { it.seat })
        assertEquals("아빠와 서준의 자리 위치를 바꿨어요.", swap.note)
        assertEquals("먼저 앉힐 사람을 눌러 주세요.", seatPick(g.members, null, SeatPick(null, "ROW_2_RIGHT")).note)
        assertNull(seatPick(g.members, SeatPick("son", "ROW_2_LEFT"), SeatPick("son", "ROW_2_LEFT")).pick)
    }

    @Test fun `앉은 사람을 고른 뒤 자리 없는 사람을 누르면 고르기만 바뀌고 아무도 자리를 잃지 않는다(폰 #413 재점검)`() {
        val g = parseGroup(JSONObject(json))
        // 아빠(앉음)를 고른 뒤 '자리 없음'의 하은 → 맞바꾸지 않고 하은을 고름
        val r = seatPick(g.members, SeatPick("dad", "ROW_1_LEFT"), SeatPick("girl", null))
        assertNull(r.members)
        assertEquals(SeatPick("girl", null), r.pick)
        // 하은(자리 없음) → 아빠 자리: 막음, 아빠는 그대로
        val blocked = seatPick(g.members, SeatPick("girl", null), SeatPick("dad", "ROW_1_LEFT"))
        assertNull(blocked.members)
        assertEquals("앉은 사람이 있는 자리예요. 빈자리를 눌러 주세요.", blocked.note)
        // 어떤 순서로 눌러도 앉아 있던 사람이 자리를 잃지 않는다
        val picks = listOf(SeatPick("dad", "ROW_1_LEFT"), SeatPick("son", "ROW_2_LEFT"), SeatPick("girl", null))
        val targets = picks + SeatPick(null, "ROW_1_RIGHT")
        for (p in picks) for (t in targets) seatPick(g.members, p, t).members?.let { assertEquals("$p → $t", emptyList<GroupMember>(), lostSeats(g.members, it)) }
        // 막는 장치: 옛 맞바꾸기(앉은 사람 ↔ 자리 없는 사람)의 결과를 잡아낸다
        assertEquals(listOf("아빠"), lostSeats(g.members, swapSeats(g.members, "dad", "girl")).map { it.name })
    }

    @Test fun `저장할 자리는 저장한 그룹과 다른 것만, 같으면 없다`() {
        val g = parseGroup(JSONObject(json))
        assertEquals(emptyMap<String, String?>(), seatChanges(g.members, g.members))
        val moved = placeSeat(g.members, "girl", "ROW_1_LEFT") // 아빠 자리로: 아빠는 하은의 원래 자리(없음)로
        assertEquals(mapOf("dad" to null, "girl" to "ROW_1_LEFT"), seatChanges(g.members, moved))
    }

    @Test fun `아이 문장은 받침에 따라 이야·야`() {
        assertEquals("“나는 서준이야. 바다에 가서 모래성을 만들 거야.”", childLine("서준"))
        assertEquals("“나는 하은이야. 바다에 가서 모래성을 만들 거야.”", childLine("하은"))
        assertEquals("“나는 지우야. 바다에 가서 모래성을 만들 거야.”", childLine("지우"))
    }

    @Test fun `아이를 저장한 뒤 좌석 지도로 가는 것은 아이가 둘 이상일 때만(시연 13→16)`() {
        val g = parseGroup(JSONObject(json)) // 아빠(대표) + 서준·하은 아이 둘
        assertEquals(true, seatsAfterChild(g.members))
        // 엄마가 이미 있어도 첫 아이(서준)만이면 가족 추가(C40)로 돌아가 하은을 더한다
        val firstChild = listOf(g.members[0], g.members[0].copy(profileId = "mom", name = "엄마", role = "adult"), g.members[1])
        assertEquals(false, seatsAfterChild(firstChild))
        assertEquals(false, seatsAfterChild(listOf(g.members[0])))
    }
}
