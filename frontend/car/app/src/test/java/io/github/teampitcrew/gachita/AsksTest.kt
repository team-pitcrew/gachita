package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AsksTest {
    private fun u(text: String, zone: Int?) = Utterance(1, "T", 0, 0, text, 0, 0, "D", zone)

    @Test fun restRequestWords() {
        assertTrue(isRestRequest("화장실 가고 싶어"))
        assertTrue(isRestRequest("나 배고파"))
        assertTrue(isRestRequest("조금 쉬었다 가자"))
        assertFalse(isRestRequest("응, 다음 휴게소 가자")) // 수락하는 말은 부탁이 아니다
        assertFalse(isRestRequest("바다는 왜 짜?"))
    }

    @Test fun answers() {
        assertEquals(Answer.YES, answerOf("응, 다음 휴게소 가자"))
        assertEquals(Answer.YES, answerOf("그래 들르자"))
        assertEquals(Answer.NO, answerOf("아니, 나중에 갈게"))
        assertEquals(Answer.NO, answerOf("휴게소 안 가도 돼"))
        assertEquals(Answer.NO, answerOf("아니 가자고 안 했어")) // 거절 낱말이 먼저
        assertEquals(Answer.UNCLEAR, answerOf("바다는 언제 보여?"))
        assertEquals(Answer.YES, answerOf("그래, 쉬었다 가자")) // 쉬어 가자는 말이 섞여도 제안이 열려 있으면 수락
        // 낱말이 통째로 같아야 한다: 다른 말 속에 든 "그래", "좋아", "응"은 답이 아니다
        assertEquals(Answer.UNCLEAR, answerOf("그래서 언제 도착해?"))
        assertEquals(Answer.UNCLEAR, answerOf("나 바다 좋아하는데"))
        assertEquals(Answer.UNCLEAR, answerOf("반응이 빠르네"))
        assertEquals(Answer.UNCLEAR, answerOf("나 안 졸려"))
        assertEquals(Answer.UNCLEAR, answerOf("네 동생은?"))
        assertEquals(Answer.UNCLEAR, answerOf("용인휴게소에 들를지 다시 말해 주세요")) // 다시 묻는 말이 마이크로 돌아와도 답이 아니다
    }

    @Test fun onlyFrontRowOrUnknownAccepts() {
        assertTrue(canAccept(u("응", null)))
        assertTrue(canAccept(u("응", 0)))
        assertFalse(canAccept(u("응", 1)))
    }

    @Test fun nextStopSkipsPassed() {
        val pangyo = 37.4127212 to 127.094681 // 에뮬레이터 기본 위치(11/13 CurrentLocationInfo)
        assertEquals("용인휴게소 강릉방향", nextStop(pangyo.first, pangyo.second)!!.name)
        // 덕평을 막 지난 자리(덕평과 여주 사이): 덕평은 지나쳤으니 여주
        assertEquals("여주맛있는휴게소 강릉방향", nextStop(37.2400, 127.4500)!!.name)
        // 위치를 모르거나 0.0(에뮬레이터가 돌려주는 빈 값)이면 첫 곳
        assertEquals("용인휴게소 강릉방향", nextStop(null, null)!!.name)
        assertEquals("용인휴게소 강릉방향", nextStop(0.0, 0.0)!!.name)
        // 마지막 휴게소도 지나면 없음
        assertEquals(null, nextStop(37.7645236, 128.8996276))
    }

    @Test fun spokenNameAndDistance() {
        assertEquals("용인휴게소", REST_STOPS[0].spoken)
        assertEquals("15 km · 30분", distanceLabel(14766, 1780))
        assertEquals("800 m · 1분", distanceLabel(800, 20))
        assertEquals("", distanceLabel(null, null))
    }
}
