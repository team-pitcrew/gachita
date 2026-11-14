package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.TimeZone

class TranscriptGroupTest {
    private val min = 60_000L
    private fun line(seq: Int, at: Long, who: String? = null) = TranscriptLine("car", seq, at, "말 $seq", who, false)

    @Test fun headersWithoutPlacesShowTimeOnly() {
        val lines = listOf(line(1, 0), line(2, 2 * min), line(3, 15 * min))
        val items = transcriptItems(lines, emptySet(), emptyList())
        assertEquals(listOf(Said.Head(0, null), Said.Line(lines[0]), Said.Line(lines[1]), Said.Head(15 * min, null), Said.Line(lines[2])), items)
    }

    @Test fun askLinesBecomeCardsAndCloseTheSection() {
        val lines = listOf(line(1, 0), line(2, min), line(3, 2 * min))
        val items = transcriptItems(lines, setOf("car" to 2), emptyList())
        assertEquals(listOf(Said.Head(0, null), Said.Line(lines[0]), Said.Ask(lines[1]), Said.Head(2 * min, null), Said.Line(lines[2])), items)
        assertTrue(transcriptItems(lines, setOf("phone" to 2), emptyList()).none { it is Said.Ask }) // 다른 기기의 같은 순번은 아님
    }

    @Test fun placeChangesOpenANewSection() {
        val places = listOf(TripPlace("동해고속도로", 0, "start"), TripPlace("하나로마트", 5 * min, "arrived"))
        assertEquals(null, placeAt(-1, places))
        assertEquals("동해고속도로", placeAt(4 * min, places))
        assertEquals("하나로마트", placeAt(5 * min, places))
        val lines = listOf(line(1, min), line(2, 3 * min), line(3, 6 * min))
        val heads = transcriptItems(lines, emptySet(), places).filterIsInstance<Said.Head>()
        assertEquals(listOf(Said.Head(min, "동해고속도로"), Said.Head(6 * min, "하나로마트")), heads)
    }

    @Test fun dateRangeChip() {
        val seoul = TimeZone.getTimeZone("Asia/Seoul")
        val start = 1_794_615_600_000L // 2026-11-14 09:20 KST
        assertEquals("11월 14일  09:20–10:28", tripRange(0, listOf(line(1, start), line(2, start + 68 * min)), seoul))
        assertEquals("11월 14일  09:20", tripRange(start, emptyList(), seoul))
    }

    @Test fun transcriptCarriesAskSources() {
        val t = parseTranscript("""{"generation":1,"utterances":[{"device":"car","seq":4,"at":1,"text":"마트에서 사자"}],
          "todos":[{"id":"x","place":"마트","text":"마트에서 사자","status":"pending","version":0,"sources":[{"device":"car","seq":4,"at":1,"text":"마트에서 사자","displayText":"마트에서 사자"}]}]}""")
        assertEquals(setOf("car" to 4), t.asks)
        assertTrue(parseTranscript("""{"generation":1,"utterances":[]}""").asks.isEmpty()) // 이전 서버
    }

    @Test fun transcriptPlacesAreOptionalAndSorted() {
        assertTrue(parseTranscript("""{"generation":1,"utterances":[]}""").places.isEmpty()) // 장소 기록(A3) 전 서버
        val t = parseTranscript("""{"generation":1,"utterances":[],"places":[{"name":"하나로마트","at":9,"kind":"arrived"},{"name":" ","at":6,"kind":"stop"},
          {"name":"집","kind":"start"},{"name":"동해고속도로","at":5,"kind":"start","lat":37.1,"lng":128.9}]}""")
        assertEquals(listOf(TripPlace("동해고속도로", 5, "start"), TripPlace("하나로마트", 9, "arrived")), t.places)
    }
}
