package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ShortTest {
    private val json = """
        {"title":"강릉 가는 길","cast":[{"participantId":"p1","name":"하은","character":"rabbit","seat":"ROW_2_RIGHT"}],
         "scenes":[{"momentId":"m1","label":"바다 이야기","at":1,"clip":"/api/trips/ABC123/recordings/m1","startAt":0,"seconds":20.5,
           "cues":[{"start":0.5,"end":2.0,"text":"바다는 왜 짜?","participantId":"p1","seatArea":"ROW_2_RIGHT"},
                   {"start":1.5,"end":4.0,"text":"소금이 있어서","participantId":null,"seatArea":"ROW_1_LEFT"},
                   {"start":5.0,"end":6.0,"text":"응","participantId":null,"seatArea":null}]}]}
    """.trimIndent()

    @Test fun readsScenesAndSpeakers() {
        val s = parseShort(json)
        assertEquals("강릉 가는 길", s.title)
        val c = s.scenes.single().cues
        assertEquals(listOf("하은", "운전석", ""), c.map { it.who }) // 못 붙인 사람은 자리 이름만, 자리도 없으면 비움
        assertEquals(20.5, s.scenes.single().seconds, 0.0)
    }

    @Test fun cueAtTime() {
        val c = parseShort(json).scenes.single().cues
        assertNull(cueAt(c, 0.2))
        assertEquals("바다는 왜 짜?", cueAt(c, 1.0)?.text)
        assertEquals("소금이 있어서", cueAt(c, 1.8)?.text) // 겹치면 나중에 시작한 줄
        assertNull(cueAt(c, 4.5))
    }

    @Test fun clipAddress() {
        assertEquals("https://gachita.mangowhois.ai/api/trips/A/recordings/m", clipUrl("https://gachita.mangowhois.ai/", "/api/trips/A/recordings/m"))
        assertEquals("https://media.example/x", clipUrl("https://gachita.mangowhois.ai", "https://media.example/x"))
    }
}
