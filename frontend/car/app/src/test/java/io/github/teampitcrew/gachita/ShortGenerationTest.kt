package io.github.teampitcrew.gachita

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ShortGenerationTest {
    private val plan = JSONObject("""{"momentId":"m","templateId":"car-sitcom-v1","generation":1,"planHash":"hash","audioReference":false,"title":"private dialogue"}""")
    @Test fun requestBindsPlanAndOmitsDialogue() {
        val body = generationRequest(plan, "stable-key", true)
        assertEquals("stable-key", body.getString("idempotencyKey"))
        assertEquals("hash", body.getString("planHash"))
        assertFalse(body.has("title")); assertFalse(body.getBoolean("audioReference"))
        assertEquals(body.toString(), generationRequest(plan, "stable-key", true).toString())
    }
    @Test(expected = IllegalArgumentException::class) fun noConsentNoRequest() { generationRequest(plan, "stable-key", false) }
    @Test fun completedVideoStaysOnAuthenticatedOrigin() {
        val job = JSONObject("""{"id":"job-1","state":"completed","result":{"url":"/api/trips/ABC123/short-generations/job-1/file"}}""")
        assertEquals("https://example.com/api/trips/ABC123/short-generations/job-1/file", generationFile("https://example.com", "ABC123", job))
        job.getJSONObject("result").put("url", "https://evil.test/video")
        assertThrows(IllegalArgumentException::class.java) { generationFile("https://example.com", "ABC123", job) }
    }
    @Test fun ambiguousSubmissionIsNotAnActiveRetry() {
        val job = JSONObject().put("state", "submission_unknown")
        assertFalse(generationActive(job)); assertTrue(generationLabel(job).contains("다시 생성하지"))
    }
}
