package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ShortTest {
    private val json = """
        {"generation":7,"title":"강릉 가는 길","cast":[{"participantId":"p1","name":"하은","character":"camping-small","seat":"ROW_2_RIGHT"}],
         "scenes":[{"momentId":"m1","label":"바다 이야기","at":1,"clip":"/api/trips/ABC123/recordings/m1","startAt":0,"seconds":20.5,
           "cues":[{"start":0.5,"end":2.0,"text":"바다는 왜 짜?","participantId":"p1","seatArea":"ROW_2_RIGHT"},
                   {"start":1.5,"end":4.0,"text":"소금이 있어서","participantId":null,"seatArea":"ROW_1_LEFT"},
                   {"start":5.0,"end":6.0,"text":"응","participantId":null,"seatArea":null}]}]}
    """.trimIndent()

    @Test fun readsScenesAndSpeakers() {
        val s = parseShort(json)
        assertEquals("강릉 가는 길", s.title)
        assertEquals(7, s.generation)
        val c = s.scenes.single().cues
        assertEquals(listOf("하은", "운전석", ""), c.map { it.who }) // 못 붙인 사람은 자리 이름만, 자리도 없으면 비움
        assertEquals(listOf("p1", null, null), c.map { it.participantId })
        assertEquals(ShortCast("p1", "하은", "camping-small", "ROW_2_RIGHT"), s.cast.single())
        assertEquals(20.5, s.scenes.single().seconds, 0.0)
    }

    @Test fun `미리보기와 MP4의 공통 계획은 폰에서 고른 작은 캐릭터를 좌석보다 먼저 쓴다`() {
        val people = listOf(Person("p1", "하은", "ROW_1_RIGHT", true, profile = true))
        for ((key, expected) in listOf("camping-small" to ShortCharacter.CAMPING_SMALL, "cap-small" to ShortCharacter.CAP_SMALL)) {
            val short = parseShort(json.replace("camping-small", key))
            val scene = short.scenes.single()
            val actor = shortSceneCast(short, scene, scene.cues.first(), people).first()
            assertEquals("p1", actor.participantId)
            assertEquals(expected, actor.character)
            assertEquals(key, actor.character?.key)
        }
    }

    @Test fun `같은 이름의 화자도 ID로 구분하고 다음 화자는 처음부터 함께 표시한다`() {
        val first = Cue(0.0, 1.0, "먼저", "지민", "first")
        val second = Cue(3.0, 4.0, "나중에", "지민", "second")
        val third = Cue(5.0, 6.0, "셋째", "지민", "third")
        val scene = Scene("장면", "", 7.0, listOf(first, second, third))
        val short = Short("여행", listOf(scene), cast = listOf(
            ShortCast("first", "지민", "camping-small", "ROW_1_RIGHT"),
            ShortCast("second", "지민", "cap-small", "ROW_2_LEFT"),
            ShortCast("third", "지민", "pet", "ROW_2_RIGHT"),
        ))
        assertEquals(listOf("first", "second"), shortSceneCast(short, scene, null, emptyList()).map { it.participantId })
        assertEquals(listOf(ShortCharacter.CAMPING_SMALL, ShortCharacter.CAP_SMALL), shortSceneCast(short, scene, first, emptyList()).map { it.character })
        assertEquals(listOf("first", "third"), shortSceneCast(short, scene, third, emptyList()).map { it.participantId })
    }

    @Test fun `화자 ID가 없거나 cast에서 중복되면 이름과 좌석이 맞아도 마스코트다`() {
        val short = parseShort(json)
        val first = short.scenes.single().cues.first()
        val people = listOf(Person("p1", "하은", "ROW_2_RIGHT", true))
        for ((cue, cast) in listOf(first.copy(participantId = null) to short.cast,
            first.copy(participantId = "missing") to short.cast, first to short.cast + short.cast)) {
            val actor = shortSceneActor(cue, cast, people)
            assertNull(actor.participantId)
            assertNull(actor.character)
        }
        val ambiguous = shortSceneActor(first, short.cast, people + people)
        assertNull(ambiguous.participantId)
        assertNull(ambiguous.character)
        val scene = short.scenes.single().copy(cues = listOf(first.copy(participantId = null, who = "")))
        val neutral = shortSceneCast(short, scene, scene.cues.single(), people)
        assertEquals(listOf(null, null), neutral.map { it.participantId })
        assertEquals(listOf("화자 미확인", "화자 미확인"), neutral.map { it.label })
        assertEquals(listOf(ShortCharacter.BASIC, ShortCharacter.BASIC_SMALL), neutral.map { it.character })
    }

    @Test fun `빈 캐릭터의 확인된 손님만 폰과 같은 좌석 기본값을 쓴다`() {
        val cue = Cue(0.0, 1.0, "안녕", "손님", "guest")
        val defaults = listOf(ShortCharacter.BASIC, ShortCharacter.CAP, ShortCharacter.GLASSES_SMALL,
            ShortCharacter.TRAVEL_SMALL, ShortCharacter.BASIC_SMALL)
        Seat.entries.forEachIndexed { i, seat ->
            val cast = listOf(ShortCast("guest", "손님", "", seat.name))
            val people = listOf(Person("guest", "손님", seat.name, true))
            assertEquals(defaults[i], shortSceneActor(cue, cast, people).character)
            assertNull(shortSceneActor(cue, cast, people.map { it.copy(profile = true) }).character)
            assertNull(shortSceneActor(cue, cast.map { it.copy(character = "unrecognized") }, people).character)
        }
    }

    @Test fun `폰의 스무 캐릭터 키는 모두 서로 다른 PNG를 쓴다`() {
        val keys = listOf("basic", "cap", "glasses", "travel", "game", "sport", "pet", "camping", "office", "healing")
            .flatMap { listOf(it, "$it-small") }.toSet()
        assertEquals(keys, ShortCharacter.entries.map { it.key }.toSet())
        assertEquals(20, ShortCharacter.entries.map { it.drawable }.toSet().size)
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
        assertEquals("https://media.gachita.mangowhois.ai/media/x", clipUrl("https://gachita.mangowhois.ai", "https://media.gachita.mangowhois.ai/media/x"))
        assertNull(clipUrl("https://gachita.mangowhois.ai", "https://evil.example/x")) // 토큰을 다른 호스트로 보내지 않는다
        assertNull(clipUrl("https://gachita.mangowhois.ai", "http://media.gachita.mangowhois.ai/x"))
    }
}
