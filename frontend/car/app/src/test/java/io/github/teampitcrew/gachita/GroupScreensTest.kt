package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 그룹 화면(C16A·B·C·G·L)의 순수 규칙. */
class GroupScreensTest {
    private fun m(id: String, name: String, seat: String?, role: String = "adult", character: String = "basic") =
        GroupMember(id, name, character, hasVoice = true, consent = true, role = role, seat = seat)

    private val family = CarGroup("g1", "우리 가족", "family", listOf(
        m("dad", "아빠", "ROW_1_LEFT", "owner", "glasses"), m("mom", "엄마", "ROW_1_RIGHT", character = "healing"),
        m("son", "서준", "ROW_2_LEFT", "child", "cap"), m("girl", "하은", null, "child"),
    ), null)
    private val solo = CarGroup("g2", "주말 바다 친구들", "guest", listOf(m("me", "민준", "ROW_1_LEFT", "owner", "glasses")), GroupInvite("TRIP-1234", "/?group=TRIP-1234"))

    @Test fun `좌석 글은 뒷자리를 뒤로 줄이고 모르는 값은 null`() {
        assertEquals("운전석", seatLabel("ROW_1_LEFT"))
        assertEquals("뒤 오른쪽", seatLabel("ROW_2_RIGHT"))
        assertNull(seatLabel(null))
        assertNull(seatLabel("ROW_3_LEFT"))
    }

    @Test fun `그룹 둘째 줄은 인원과 종류, 혼자인 동승 그룹은 그룹 저장 직후에도 초대 대기(시안 C16L)`() {
        assertEquals("4명  |  기본 그룹", groupLine(family))
        assertEquals("1명  |  초대 대기", groupLine(solo))
        assertEquals("1명  |  초대 대기", groupLine(solo.copy(invite = null)))
        assertEquals("2명  |  동승 그룹", groupLine(solo.copy(members = solo.members + m("f", "지우", null))))
    }

    @Test fun `좌석 칸은 시안대로 2x2, 뒤 가운데에 앉은 사람이 있으면 그 칸을 더함`() {
        assertEquals(listOf(Seat.ROW_2_LEFT, Seat.ROW_2_RIGHT), gridSeats(family.members)[1])
        assertEquals(listOf(Seat.ROW_2_LEFT, Seat.ROW_2_CENTER, Seat.ROW_2_RIGHT), gridSeats(family.members + m("c", "지민", "ROW_2_CENTER"))[1])
    }

    @Test fun `출발 전 자리 없는 사람은 빈자리에 앞에서 뒤로, 자리가 모자라면 남김`() {
        val joined = listOf(m("dad", "민준", "ROW_1_LEFT"), m("a", "지환", null), m("b", "지민", null), m("c", "상현", "ROW_2_LEFT"))
        assertEquals(mapOf("a" to "ROW_1_RIGHT", "b" to "ROW_2_RIGHT"), autoSeats(joined))
        assertEquals(emptyMap<String, String>(), autoSeats(family.members.filter { it.seat != null }))
        val six = (1..6).map { m("p$it", "사람$it", null) }
        assertEquals(5, autoSeats(six).size)
    }

    @Test fun `목소리 없는 아이는 동의가 켜진 아이만 다시 묻고, 동의 꺼진 아이는 예외`() {
        val kid = m("k", "서준", null, role = "child").copy(hasVoice = false)
        val g = family.copy(members = family.members + kid)
        assertEquals("k", childWithoutVoice(g)?.profileId)
        assertNull(childWithoutVoice(g.copy(members = family.members + kid.copy(hasVoice = true))))
        assertNull(childWithoutVoice(g.copy(members = family.members + kid.copy(consent = false))))
        assertNull(childWithoutVoice(null))
    }

    @Test fun `출발 전 목소리 없는 사람 - 어른과 동의 켜진 아이, 동의 꺼진 아이는 예외`() {
        val adult = m("a", "지환", "ROW_1_RIGHT").copy(hasVoice = false)
        val kid = m("k", "서준", "ROW_2_LEFT", role = "child").copy(hasVoice = false)
        val offKid = kid.copy(profileId = "o", consent = false)
        assertEquals(listOf("a", "k"), voiceMissing(family.members + adult + kid + offKid).map { it.profileId })
        assertEquals(emptyList<GroupMember>(), voiceMissing(family.members))
    }

    @Test fun `혼자인 동승 그룹만 초대부터`() {
        assertTrue(soloGuest(solo))
        assertFalse(soloGuest(family))
        assertFalse(soloGuest(solo.copy(members = solo.members + m("f", "지우", null))))
    }

    @Test fun `전체 그룹은 가족이 먼저`() {
        assertEquals(listOf("g1", "g2"), groupsInOrder(listOf(solo, family)).map { it.id })
    }

    @Test fun `구성원과 좌석은 자리 순서로, 자리 없는 사람은 시안처럼 줄을 두지 않음`() {
        assertEquals(listOf("운전석" to "아빠", "조수석" to "엄마", "뒤 왼쪽" to "서준"), seatLines(family.members))
        assertEquals(listOf("운전석" to "아빠", "뒤 오른쪽" to "하은"), seatLines(listOf(m("girl", "하은", "ROW_2_RIGHT"), m("dad", "아빠", "ROW_1_LEFT"))))
    }

    @Test fun `2x2 칸은 앞 네 사람, 남으면 초대 중 하나와 미등록`() {
        assertEquals(listOf(FaceSlot.Member("glasses"), FaceSlot.Member("healing"), FaceSlot.Member("cap"), FaceSlot.Member("basic")), faceSlots(family))
        assertEquals(listOf(FaceSlot.Member("glasses"), FaceSlot.Inviting, FaceSlot.Empty, FaceSlot.Empty), faceSlots(solo))
        assertEquals(listOf(FaceSlot.Member("glasses"), FaceSlot.Empty, FaceSlot.Empty, FaceSlot.Empty), faceSlots(solo.copy(invite = null)))
        val five = family.copy(members = family.members + m("x", "지우", null), invite = GroupInvite("FAMILY-1", "/"))
        assertEquals(4, faceSlots(five).count { it is FaceSlot.Member })
    }

    @Test fun `구성원 선택은 빈자리에 앉히고 앉은 사람끼리 맞바꾼다`() {
        val placed = pickFor(family.members, "ROW_2_RIGHT", "girl")
        assertEquals("ROW_2_RIGHT", placed.members!!.first { it.profileId == "girl" }.seat)
        assertEquals("하은을 뒤 오른쪽에 앉혔어요.", placed.note)

        val swapped = pickFor(family.members, "ROW_1_LEFT", "mom") // 운전석에 엄마 → 아빠와 맞바꿈
        assertEquals(listOf("ROW_1_RIGHT", "ROW_1_LEFT", "ROW_2_LEFT", null), swapped.members!!.map { it.seat })

        val moved = pickFor(family.members, "ROW_2_RIGHT", "son") // 앉은 사람을 빈자리로 옮기면 원래 자리는 빈다
        assertEquals(listOf("ROW_1_LEFT", "ROW_1_RIGHT", "ROW_2_RIGHT", null), moved.members!!.map { it.seat })
    }

    @Test fun `자리 없는 사람은 앉은 사람의 자리에 넣지 않아 아무도 자리를 잃지 않는다`() {
        val refused = pickFor(family.members, "ROW_1_LEFT", "girl")
        assertNull(refused.members)
        assertEquals("하은은 자리가 없어 앉은 사람과 바꿀 수 없어요. 빈자리를 골라 주세요.", refused.note)
        assertEquals(SeatResult(null, null, null), pickFor(family.members, "ROW_1_LEFT", "dad")) // 이미 그 자리
        // 어떤 고르기 뒤에도 앉아 있던 사람은 자리를 잃지 않는다(저장 가능)
        for (seat in listOf("ROW_1_LEFT", "ROW_1_RIGHT", "ROW_2_LEFT", "ROW_2_RIGHT")) for (who in family.members) {
            val r = pickFor(family.members, seat, who.profileId).members ?: continue
            assertTrue(lostSeats(family.members, r).isEmpty())
        }
    }
}
