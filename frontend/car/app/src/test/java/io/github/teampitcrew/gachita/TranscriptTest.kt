package io.github.teampitcrew.gachita

import org.junit.Assert.*
import org.junit.Test

class TranscriptTest {
    @Test fun respectsEditsAndDoesNotInventSpeakerFromSeat() {
        val transcript = parseTranscript("""{"generation":3,"utterances":[
          {"device":"car","seq":2,"at":200,"text":"original","editedText":"corrected","seatArea":"ROW_1_LEFT"},
          {"device":"car","seq":1,"at":100,"text":"first","participantId":"person"},
          {"device":"car","seq":3,"at":300,"text":"deleted","editedText":""}
        ]}""")
        assertEquals(3, transcript.generation)
        assertEquals(listOf("first", "corrected"), transcript.lines.map { it.text })
        assertEquals("person", transcript.lines[0].participantId)
        assertNull(transcript.lines[1].participantId)
        assertTrue(transcript.lines[1].edited)
    }
    @Test fun prefersServerDisplayText() {
        val result = parseTranscript("""{"generation":1,"utterances":[{"device":"car","seq":1,"at":1,"text":"raw","displayText":"display","editedText":null}]}""")
        assertEquals("display", result.lines.single().text)
    }
}
