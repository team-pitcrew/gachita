package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
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
}
