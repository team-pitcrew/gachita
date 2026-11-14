package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

class AsksTest {
    private fun u(text: String, zone: Int?) = Utterance(1, "T", 0, 0, text, 0, 0, 1, seatZone = zone)

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

    @Test fun routedStopsFromServer() {
        val json = """{"items":[{"name":"덕평휴게소","route":"영동선","lat":37.24133,"lng":127.389428,"meters":11500},
            {"name":"여주휴게소 강릉방향","route":"영동선","lat":37.238548,"lng":127.569035,"meters":27400}],"source":"한국도로공사"}"""
        val stops = restStopsOf(json)
        assertEquals(listOf("덕평휴게소", "여주휴게소"), stops.map { it.spoken })
        assertEquals(37.238548, stops[1].lat, 1e-9)
        assertEquals(emptyList<Place>(), restStopsOf("""{"items":[],"source":"x"}"""))
    }

    @Test fun onRoadByNaviDistance() {
        assertTrue(onRoad(11_500.0, 13_000, 160_000)) // 같은 길 앞쪽: 길 위 거리가 직선과 비슷
        assertFalse(onRoad(13_000.0, 30_000, 160_000)) // 나란한 고속도로: 분기점을 돌아 두 배 넘게 김
        assertFalse(onRoad(5_000.0, 9_000, 8_000)) // 목적지보다 멀다
        assertTrue(onRoad(5_000.0, null, null)) // 내비가 답하지 않으면 막지 않는다
        assertTrue(onRoad(1_000.0, 3_400, null)) // 가까운 곳은 나들목 진입 거리(2 km)까지 봐준다
    }

    @Test fun fixedListOnlyWhenServerUnusable() {
        val routed = listOf(Place(37.53, 127.21, "하남드림휴게소"))
        assertEquals(routed, stopsFrom(Result.success(routed), 37.39, 127.11))
        assertEquals(emptyList<Place>(), stopsFrom(Result.success(emptyList()), 37.4, 127.1)) // 서버가 '앞에 없음'이라 하면 고정 목록으로 가지 않는다
        assertEquals(listOf("용인휴게소"), stopsFrom(Result.failure(java.io.IOException("꺼짐")), 37.2, 127.1).map { it.spoken })
        assertEquals(REST_STOPS.first(), stopsFrom(Result.failure(IllegalStateException("위치 모름")), null, null).single())
    }

    @Test fun sharedLookupAnswersEveryWaiter() {
        val d = Shared<String>()
        val got = mutableListOf<String?>()
        val round = d.join { got += "도착:$it" } // 도착 알림이 먼저 목적지를 묻는다
        assertEquals(1, round)
        assertEquals(null, d.join { got += "추천:$it" }) // 그동안 휴게소 추천이 물어도 다시 묻지 않고 끊지도 않는다
        d.answer("마트")
        assertEquals(listOf("도착:마트", "추천:마트"), got)
        val next = d.join { got += "다음:$it" }!!
        d.answer(null, round) // 앞 차례의 늦은 시간 초과는 다음 차례를 끊지 않는다
        assertEquals(2, got.size)
        d.answer(null, next)
        assertEquals("다음:null", got.last())
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

    @Test fun ownVoiceWindow() {
        assertFalse(overlapsSpeech(1_000, 0, 0)) // 아직 말한 적 없음
        assertTrue(overlapsSpeech(10_500, 10_000, Long.MAX_VALUE)) // 말하는 중에 온 첫 결과
        assertTrue(overlapsSpeech(12_200, 10_000, 12_000)) // 끝난 뒤 0.3초 안
        assertFalse(overlapsSpeech(12_500, 10_000, 12_000)) // 말이 끝난 뒤 바로 한 "응"(첫 결과 0.4초 넘게 걸림)
        assertFalse(overlapsSpeech(9_500, 10_000, 12_000)) // 우리가 말하기 전에 시작된 말
    }

    @Test fun spokenNameAndDistance() {
        assertEquals("용인휴게소", REST_STOPS[0].spoken)
        assertEquals("15 km · 30분", distanceLabel(14766, 1780))
        assertEquals("800 m · 1분", distanceLabel(800, 20))
        assertEquals("", distanceLabel(null, null))
    }

    @Test fun `추천 통신이 막혀도 2초에 고정 목록으로 넘어가고 늦은 답은 버린다(Astra 3차)`() {
        val exec = Executors.newSingleThreadExecutor()
        val dns = CountDownLatch(1) // DNS처럼 끊을 수 없는 대기
        val got = LinkedBlockingQueue<Pair<Result<List<Place>>, Long>>()
        val t0 = System.nanoTime()
        within(exec, 2_000, { dns.await(); listOf(Place(37.5, 127.2, "늦게 온 추천")) }) { got += it to (System.nanoTime() - t0) / 1_000_000 }

        val (r, ms) = got.poll(3, TimeUnit.SECONDS)!!
        assertTrue(r.exceptionOrNull() is TimeoutException)
        assertTrue("$ms ms", ms in 1_900..2_500)
        assertEquals(listOfNotNull(nextStop(37.39, 127.11)), stopsFrom(r, 37.39, 127.11)) // 고정 목록
        dns.countDown()
        assertNull(got.poll(500, TimeUnit.MILLISECONDS)) // 늦게 온 답으로 다시 확정하지 않는다

        // 제때 온 답은 그대로, 한 번만(마감이 뒤에 다시 부르지 않음)
        within(exec, 300, { listOf(Place(1.0, 2.0, "추천")) }) { got += it to 0L }
        assertEquals("추천", got.poll(1, TimeUnit.SECONDS)!!.first.getOrThrow().single().name)
        assertNull(got.poll(600, TimeUnit.MILLISECONDS))
        exec.shutdown()
    }
}
