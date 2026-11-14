package io.github.teampitcrew.gachita

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ShortGenerationTest {
    @Test fun completedVideoStaysOnAuthenticatedOrigin() {
        val job = JSONObject("""{"id":"job-1","state":"completed","result":{"url":"/api/trips/ABC123/short-generations/job-1/file"}}""")
        assertEquals("https://example.com/api/trips/ABC123/short-generations/job-1/file", generationFile("https://example.com", "ABC123", job))
        job.getJSONObject("result").put("url", "https://evil.test/video")
        assertThrows(IllegalArgumentException::class.java) { generationFile("https://example.com", "ABC123", job) }
    }
}
