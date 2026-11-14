package io.github.teampitcrew.gachita

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.net.ServerSocket
import kotlin.concurrent.thread

/** 실제 HTTP로 응답 처리만 본다(소켓으로 응답 하나를 돌려주는 서버). PATCH는 JVM의 HttpURLConnection이 받지 않아 여기서 보지 않는다. */
class ServerTest {
    private fun serve(status: Int, body: String, test: (String) -> Unit) {
        val sock = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
        thread(isDaemon = true) {
            sock.accept().use { c ->
                val r = c.getInputStream().bufferedReader()
                while (r.readLine().orEmpty().isNotEmpty()) Unit // 요청 머리를 빈 줄까지 읽는다
                val b = body.toByteArray()
                c.getOutputStream().apply {
                    write("HTTP/1.1 $status X\r\nContent-Type: text/html\r\nContent-Length: ${b.size}\r\nConnection: close\r\n\r\n".toByteArray())
                    write(b); flush()
                }
            }
        }
        try { test("http://127.0.0.1:${sock.localPort}/") } finally { sock.close() }
    }

    @Test fun `200인데 여행 JSON이 아니면 서버 거절이 아닌 연결 문제로 던진다`() = serve(200, "<html>로그인하세요</html>") { url ->
        val e = runCatching { Server(url).trip("AB23CD") }.exceptionOrNull()
        assertNotNull(e)
        assertFalse(e is ApiError) // 앱은 ApiError가 아니면 '연결이 끊겼어요'로 다룬다
    }

    @Test fun `바뀐 것이 없으면(304) null`() = serve(304, "") { url ->
        assertNull(Server(url).trip("AB23CD", 3))
    }

    @Test fun `서버가 거절하면 ApiError`() = serve(404, """{"error":"여행이 없습니다"}""") { url ->
        assertTrue(runCatching { Server(url).trip("AB23CD") }.exceptionOrNull() is ApiError)
    }

    @Test fun `앞단 502는 거절이 아니라 잠깐 못 받은 것으로 보이고 본문을 붙이지 않는다(T122)`() = serve(502, "error code: 502") { url ->
        val e = runCatching { Server(url).trip("AB23CD") }.exceptionOrNull()
        assertTrue(e is ApiError && e.transient)
        assertEquals(listOf(502, 503, 504), (499..506).filter { ApiError(it, "x").transient }) // 500·501·505는 거절로 본다
        assertEquals("서버가 잠깐 응답하지 않아요", failureText(e!!))
        assertEquals("서버가 거절했어요(409 이미 다른 사람이 앉은 자리)", failureText(ApiError(409, "이미 다른 사람이 앉은 자리")))
        assertEquals("서버에 닿지 않아요", failureText(java.io.IOException()))
    }

    @Test fun `잠깐 못 받은 응답만 두 번 더 묻고, 거절과 통신 실패는 바로 던진다(T122)`() {
        val slept = mutableListOf<Long>()
        var n = 0
        assertEquals("ok", retryTransient(sleep = { slept += it }) { if (++n < 3) throw ApiError(503, "x") else "ok" })
        assertEquals(3, n); assertEquals(listOf(500L, 1000L), slept)

        n = 0
        assertTrue(runCatching { retryTransient<Unit>(sleep = {}) { n++; throw ApiError(504, "x") } }.exceptionOrNull() is ApiError)
        assertEquals(3, n) // 처음 + 두 번

        for (e in listOf(ApiError(409, "x"), Gone("AB23CD"), java.io.IOException())) {
            n = 0
            assertTrue(runCatching { retryTransient<Unit>(sleep = {}) { n++; throw e } }.exceptionOrNull() === e)
            assertEquals(1, n)
        }
    }

    /** 머리말은 바로 보내고 본문은 dripMs마다 한 바이트씩(readTimeout이 매번 다시 시작되는 느린 서버). */
    private fun drip(body: String, dripMs: Long, test: (String) -> Unit) {
        val sock = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
        thread(isDaemon = true) {
            runCatching {
                sock.accept().use { c ->
                    val r = c.getInputStream().bufferedReader()
                    while (r.readLine().orEmpty().isNotEmpty()) Unit
                    val b = body.toByteArray()
                    val out = c.getOutputStream()
                    out.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${b.size}\r\nConnection: close\r\n\r\n".toByteArray()); out.flush()
                    for (x in b) { Thread.sleep(dripMs); out.write(x.toInt()); out.flush() }
                }
            }
        }
        try { test("http://127.0.0.1:${sock.localPort}/") } finally { sock.close() }
    }

    private val stops = """{"items":[{"name":"덕평휴게소","route":"영동선","lat":37.24133,"lng":127.389428,"meters":11500}],"source":"x"}"""

    @Test fun `휴게소 추천은 답이 빠르면 그대로 받는다`() = drip(stops, 0) { url ->
        assertEquals(listOf("덕평휴게소"), Server(url).restStops(37.2459, 127.26, 80.0, null, null).map { it.name })
    }

    @Test fun `휴게소 추천은 본문이 조금씩 와도 전체 2초에 끊는다`() = drip(stops, 300) { url ->
        val t0 = System.currentTimeMillis()
        val e = runCatching { Server(url).restStops(37.2459, 127.26, 80.0, null, null) }.exceptionOrNull()
        val took = System.currentTimeMillis() - t0
        assertTrue("마감 예외여야 함: $e", e is SocketTimeoutException)
        assertTrue("2초 마감인데 ${took}ms 걸림", took in 1900..3000) // 본문 전체를 다 받으려면 한 바이트 300ms라 수십 초
    }

    /** 요청마다 serve가 답을 정하는 가짜 연결(JVM의 HttpURLConnection은 PATCH를 받지 않아 setRequestMethod를 덮는다). */
    private class Fake(url: URL, val serve: (Fake) -> Pair<Int, String>) : HttpURLConnection(url) {
        val sent = ByteArrayOutputStream()
        private val answer by lazy { serve(this) }
        override fun connect() {}
        override fun disconnect() {}
        override fun usingProxy() = false
        override fun setRequestMethod(value: String) { method = value }
        override fun getResponseCode() = answer.first
        override fun getOutputStream() = sent
        override fun getInputStream() = answer.second.byteInputStream()
        override fun getErrorStream() = answer.second.byteInputStream()
    }

    private fun trip(consent: Boolean) = """{"code":"AB23CD","title":"t","status":"boarding","recording":false,
        "participants":[{"id":"p0","name":"아빠","seat":"ROW_1_LEFT","prefs":{},"consent":$consent}],"requests":[],"moments":[],"version":3,"createdAt":1}"""

    @Test fun `동의 켜기 뒤 조회만 다시 묻고, 그사이 다른 기기의 철회를 되살리지 않는다(Astra #352)`() {
        var consent = false
        val calls = mutableListOf<String>()
        var gets = 0
        val api = Server("http://x") { url -> Fake(url) { c ->
            calls += c.requestMethod
            when (c.requestMethod) {
                "PATCH" -> { consent = JSONObject(c.sent.toString("UTF-8")).getBoolean("consent"); 200 to """{"id":"p0","consent":$consent}""" }
                else -> if (++gets == 1) { consent = false; 502 to "error code: 502" } // 조회가 502인 사이 다른 기기가 철회
                        else 200 to trip(consent)
            }
        } }
        val got = api.agree("AB23CD", "p0", "token")
        assertEquals(listOf("PATCH", "GET", "GET"), calls) // PATCH는 한 번
        assertFalse(consent)
        assertFalse(got.trip.people.single().consent) // 철회가 그대로 보인다

        // PATCH 자체가 502면(닿았는지 모름) 다시 보내지 않고 던진다 → 사용자가 다시 누른다
        calls.clear()
        val failing = Server("http://x") { url -> Fake(url) { c -> calls += c.requestMethod; 502 to "error code: 502" } }
        val e = runCatching { failing.agree("AB23CD", "p0", "token") }.exceptionOrNull()
        assertTrue(e is ApiError && e.transient)
        assertEquals(listOf("PATCH"), calls)
    }
}
