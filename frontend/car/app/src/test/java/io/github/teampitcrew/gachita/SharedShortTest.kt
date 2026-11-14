package io.github.teampitcrew.gachita

import java.net.ServerSocket
import java.net.InetAddress
import kotlin.concurrent.thread
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.concurrent.CancellationException

class SharedShortTest {
    private val id = "12345678-1234-1234-1234-123456789abc"
    private fun sourceValue() = JSONObject().put("momentId", "moment-1").put("generation", 2).put("sourceHash", "a".repeat(64)).put("seconds", 2.0)
        .put("source", JSONObject().put("title", "여행").put("generation", 2).put("cast", JSONArray()).put("scenes", JSONArray().put(JSONObject()
            .put("momentId", "moment-1").put("label", "우리 대화").put("clip", "/api/trips/ABCD/moments/moment-1/clip").put("seconds", 2.0).put("cues", JSONArray()))))
    private fun item(hash: String = "b".repeat(64)) = JSONObject().put("id", id).put("origin", "local-render").put("state", "completed")
        .put("momentId", "moment-1").put("generation", 2).put("sourceHash", "a".repeat(64))
        .put("result", JSONObject().put("url", "/api/trips/ABCD/short-assets/$id/file").put("sha256", hash).put("mimeType", "video/mp4"))
    // 리허설 run2: 같은 요청 키를 다시 보내 409 — 목록에 같은 파일이 보관 완료면 성공, 아니면 실패
    @Test fun sameUploadAlreadyStoredCountsOnlyForTheSameFile() {
        val source = parseSharedShortSource(sourceValue()); val b = "b".repeat(64)
        assertEquals(id, storedShort(JSONArray().put(item("c".repeat(64))).put(item()), source, b)?.getString("id"))
        assertEquals(null, storedShort(JSONArray().put(item("c".repeat(64))), source, b)) // 다른 파일
        assertEquals(null, storedShort(JSONArray().put(item().put("sourceHash", "d".repeat(64))), source, b)) // 원음이 바뀐 뒤 것
        assertEquals(null, storedShort(JSONArray().put(item().put("state", "uploading").apply { remove("result") }), source, b)) // 아직 보관 중
        assertEquals(null, storedShort(JSONArray().put(item().put("generation", 3)), source, b))
    }
    @Test fun sourceMustBindOneMomentAndConsentGeneration() {
        val good = parseSharedShortSource(sourceValue())
        assertEquals("moment-1", good.short.scenes.single().momentId)
        assertThrows(IllegalArgumentException::class.java) { parseSharedShortSource(sourceValue().put("momentId", "other")) }
        assertThrows(IllegalArgumentException::class.java) { parseSharedShortSource(sourceValue().put("generation", 3)) }
        val many = sourceValue(); many.getJSONObject("source").getJSONArray("scenes").put(many.getJSONObject("source").getJSONArray("scenes").get(0))
        assertThrows(IllegalArgumentException::class.java) { parseSharedShortSource(many) }
        assertFalse(sharedShortSame(good, good.copy(hash = "b".repeat(64))))
    }
    @Test fun filePathCannotSendAuthToOtherOriginOrSourceChangedAsset() {
        assertEquals("https://example.org/api/trips/ABCD/short-assets/$id/file", sharedShortFile("https://example.org", "ABCD", item()))
        val hostile = item(); hostile.getJSONObject("result").put("url", "https://other.example/file")
        assertThrows(IllegalArgumentException::class.java) { sharedShortFile("https://example.org", "ABCD", hostile) }
        assertThrows(IllegalArgumentException::class.java) { sharedShortFile("https://example.org", "ABCD", item().put("state", "source_changed")) }
        assertThrows(IllegalArgumentException::class.java) { sharedShortFile("https://name:password@example.org", "ABCD", item()) }
    }
    @Test fun streamingRetryPreservesBytesLengthKeyAndHash() {
        val file = File.createTempFile("shared-test-", ".mp4");file.writeBytes(ByteArray(256_000) { (it % 255).toByte() })
        val seen = mutableListOf<String>(); val errors = mutableListOf<Throwable>()
        val hash = shortFileHash(file)
        val server = ServerSocket(0, 2, InetAddress.getByName("127.0.0.1"))
        val worker = thread(isDaemon = true) {
            repeat(2) { index -> server.accept().use { socket ->
                socket.soTimeout = 5000
                try {
                    val input = socket.getInputStream()
                    fun line(): String { val bytes = java.io.ByteArrayOutputStream(); while (true) { val b = input.read(); if (b < 0 || b == 10) break; if (b != 13) bytes.write(b) }; return bytes.toString("UTF-8") }
                    val request = line().split(" ")
                    val headers = mutableMapOf<String, String>()
                    while (true) { val line = line(); if (line.isEmpty()) break; headers[line.substringBefore(':').lowercase()] = line.substringAfter(':').trim() }
                    assertEquals("POST", request[0]); assertEquals("Bearer test-participant", headers["authorization"])
                    assertEquals("video/mp4", headers["content-type"]); assertEquals(file.length().toString(), headers["content-length"])
                    val body = ByteArray(headers.getValue("content-length").toInt()); java.io.DataInputStream(input).readFully(body)
                    assertArrayEquals(file.readBytes(), body); seen += request[1].substringAfter('?')
                    val reply = item(hash).toString().toByteArray()
                    socket.getOutputStream().write(("HTTP/1.1 ${if (index == 0) "201 Created" else "200 OK"}\r\nContent-Type: application/json\r\nContent-Length: ${reply.size}\r\nConnection: close\r\n\r\n").toByteArray() + reply)
                } catch(e: Throwable) { errors += e }
            } }
        }
        try {
            val api = SharedShortApi("http://127.0.0.1:${server.localPort}");val source = parseSharedShortSource(sourceValue())
            repeat(2) { assertEquals(id, api.upload("ABCD", "test-participant", source, file, "same-key-123", hash) {}.getString("id")) }
            assertTrue(errors.toString(), errors.isEmpty());assertEquals(2, seen.size);assertEquals(seen[0], seen[1]);assertTrue(seen[0].contains("key=same-key-123"))
            file.appendText("changed")
            assertThrows(IllegalArgumentException::class.java) { api.upload("ABCD", "test-participant", source, file, "same-key-123", hash) {} }
            assertEquals(2, seen.size)
        } finally { server.close();worker.join(2000);file.delete() }
    }
    @Test fun cancellationStopsBeforeAnyRequest() {
        val api = SharedShortApi("http://127.0.0.1:1");api.cancel()
        assertThrows(CancellationException::class.java) { api.list("ABCD", "test-participant") }
    }
}
