package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** 장소 기록(T131): 내비 상태가 바뀔 때만 한 번씩 남기고, 못 보낸 것은 다시 켜도 남고, 동의 세대가 오르면 옛 것을 버린다. */
class PlacesTest {
    @get:Rule val tmp = TemporaryFolder()
    private val mart = Place(37.75, 128.87, "하나로마트")
    private val inn = Place(37.80, 128.90, "숙소")

    @Test fun startDestinationApproachingArrivedOnce() {
        val log = PlaceLog(tmp.root, "ABC123", TEST_SEAL)
        assertFalse(log.see(false, null, null, null, 1, 1_000)) // 주차 중, 목적지 없음
        assertTrue(log.see(true, inn, 1_800, Fix(37.7, 128.8, 1_500), 1, 2_000))
        assertFalse(log.see(true, inn, 1_700, null, 1, 12_000)) // 같은 목적지, 아직 멀다
        assertTrue(log.see(true, inn, 280, null, 1, 22_000))
        assertFalse(log.see(true, inn, 200, null, 1, 32_000)) // 곧 도착은 한 번
        assertTrue(log.arrived(mart, 1, 40_000)) // 목적지가 아닌 곳에 닿음 → 경유
        assertFalse(log.arrived(mart, 1, 50_000)) // 머무는 동안 한 번
        log.see(true, inn, 120, null, 1, 60_000) // 다시 출발
        assertTrue(log.arrived(inn, 1, 90_000))
        assertEquals(listOf("start" to "출발", "destination" to "숙소", "approaching" to "숙소", "stop" to "하나로마트", "arrived" to "숙소"), log.queue.map { it.kind to it.name })
        assertEquals(37.7, log.queue[0].lat!!, 0.0)
        assertEquals(280, log.queue[2].etaSeconds)
        assertEquals(40_000L, log.queue[3].at)
        val body = log.queue[2].body()
        assertEquals(setOf("kind", "name", "at", "lat", "lng", "etaSeconds"), body.keys().asSequence().toSet()) // 세대는 차 안에만
        assertEquals(listOf("approaching", "숙소", 22_000L, 280), listOf(body.getString("kind"), body.getString("name"), body.getLong("at"), body.getInt("etaSeconds")))
    }

    @Test fun pendingSurvivesRestartAndDropsOldGeneration() {
        val log = PlaceLog(tmp.root, "ABC123", TEST_SEAL)
        log.see(true, inn, 900, null, 1, 1_000)
        log.done(log.next(1)!!) // 출발은 보냄
        val again = PlaceLog(tmp.root, "ABC123", TEST_SEAL)
        assertEquals(listOf("destination"), again.queue.map { it.kind })
        assertFalse(again.see(true, inn, 900, null, 1, 11_000)) // 다시 켜도 출발·목적지를 다시 남기지 않음
        assertNull(again.next(2)) // 누군가 철회해 세대가 오름: 옛 세대 것은 보내지 않는다
        assertTrue(again.queue.isEmpty())
        assertTrue(dropTrip(tmp.root, "ABC123").let { tmp.root.listFiles().orEmpty().none { it.name.startsWith("places-") } })
    }
}
