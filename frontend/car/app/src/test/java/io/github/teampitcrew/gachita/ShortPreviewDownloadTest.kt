package io.github.teampitcrew.gachita

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class ShortPreviewDownloadTest {
    private fun temporary() = File.createTempFile("short-preview-test", ".wav")
    private class Connection : HttpURLConnection(URL("http://localhost/")) {
        var disconnected = false
        override fun connect() = Unit
        override fun usingProxy() = false
        override fun disconnect() { disconnected = true }
    }

    @Test fun `취소 뒤 등록된 연결은 바로 정리하고 파일을 다시 열 수 없다`() {
        val file = temporary()
        val request = ShortPreviewDownload(file) { it.disconnect() }
        request.cancel()
        val connection = Connection()
        request.trackConnection(connection)
        request.ready()
        assertTrue(connection.disconnected)
        assertTrue(request.isCancelled)
        assertFalse(file.exists())
        assertNull(request.takeFile())
        assertTrue(runCatching { request.openOutput() }.isFailure)
        assertFalse(file.exists())
    }

    @Test fun `완료 콜백 대기 중 취소하면 결과를 다시 넘기지 않는다`() {
        val file = temporary()
        val request = ShortPreviewDownload(file) { it.disconnect() }
        request.openOutput().use { it.write(byteArrayOf(1, 2, 3)) }
        request.ready()
        request.cancel()
        request.ready()
        assertNull(request.takeFile())
        assertFalse(file.exists())
    }

    @Test fun `넘긴 파일은 수신자가 소유하며 한 번만 받을 수 있다`() {
        val file = temporary()
        try {
            val request = ShortPreviewDownload(file) { it.disconnect() }
            request.ready()
            assertEquals(file, request.takeFile())
            assertNull(request.takeFile())
            request.cancel()
            assertTrue(file.exists())
        } finally { file.delete() }
    }

    @Test fun `이전 요청을 취소해도 새 요청 파일은 지우지 않는다`() {
        val first = temporary()
        val second = temporary()
        try {
            val old = ShortPreviewDownload(first) { it.disconnect() }
            val next = ShortPreviewDownload(second) { it.disconnect() }
            old.cancel(); old.ready(); next.ready()
            assertNull(old.takeFile())
            assertEquals(second, next.takeFile())
            assertFalse(first.exists())
            assertTrue(second.exists())
        } finally { first.delete(); second.delete() }
    }

    @Test fun `취소와 소유권 이전 경합에서도 파일 소유자는 하나다`() {
        repeat(100) {
            val file = temporary()
            try {
                val request = ShortPreviewDownload(file) { it.disconnect() }
                request.ready()
                val start = CountDownLatch(1)
                val cancel = thread { start.await(); request.cancel() }
                start.countDown()
                val owned = request.takeFile()
                cancel.join(1000)
                assertFalse(cancel.isAlive)
                assertEquals(owned != null, file.exists())
                assertNull(request.takeFile())
            } finally { file.delete() }
        }
    }

    @Test fun `장면 주소는 같은 출처와 현재 여행 경로만 허용한다`() {
        val path = "/api/trips/ABC123/recordings/clip-1"
        assertEquals("https://gachita.test$path", shortClipAddress("https://gachita.test/", "ABC123", path))
        assertEquals("http://127.0.0.1:8894$path", shortClipAddress("http://127.0.0.1:8894", "ABC123", "http://127.0.0.1:8894$path"))
        listOf(
            "https://other.test$path", "https://media.gachita.test$path", "http://gachita.test$path",
            "https://gachita.test:444$path", "https://user@gachita.test$path", "//other.test$path",
            "/api/trips/OTHER1/recordings/clip-1", "$path?token=x", "$path#x", "/api/trips/ABC123/recordings/%2e%2e",
            "/api/trips/ABC123/recordings/../clip-1", "file:///api/trips/ABC123/recordings/clip-1"
        ).forEach { clip -> assertTrue(clip, runCatching { shortClipAddress("https://gachita.test", "ABC123", clip) }.isFailure) }
    }

    /** JVM은 PATCH를 지원하지 않아 일반 API 줄에서 실제 transcript GET이 바로 도착하는지 확인합니다. */
    @Test fun `느린 HTTP 미리듣기 취소는 부분 파일과 늦은 결과를 거두고 일반 API를 막지 않는다`() {
        val socket = ServerSocket(0, 4, InetAddress.getLoopbackAddress())
        val sockets = java.util.concurrent.ConcurrentLinkedQueue<Socket>()
        val initialBody = CountDownLatch(1)
        val releaseBody = CountDownLatch(1)
        val apiArrived = CountDownLatch(1)
        val apiDone = CountDownLatch(1)
        val workerDone = CountDownLatch(1)
        val disconnectCalled = CountDownLatch(1)
        val previewIo = Executors.newSingleThreadExecutor()
        val apiIo = Executors.newSingleThreadExecutor()
        val closeIo = Executors.newSingleThreadExecutor()
        val file = temporary()
        val request = ShortPreviewDownload(file) { connection -> closeIo.execute { disconnectCalled.countDown(); connection.disconnect() } }
        val serverThread = thread(isDaemon = true) {
            repeat(2) {
                val client = runCatching { socket.accept() }.getOrNull() ?: return@thread
                sockets.add(client)
                thread(isDaemon = true) {
                    runCatching {
                        client.use {
                            val input = client.getInputStream().bufferedReader()
                            val line = input.readLine()
                            while (input.readLine().orEmpty().isNotEmpty()) Unit
                            val output = client.getOutputStream()
                            if (line.contains("/recordings/")) {
                                output.write("HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\n1234".toByteArray())
                                output.flush(); initialBody.countDown()
                                releaseBody.await(5, TimeUnit.SECONDS)
                                output.write("5678".toByteArray()); output.flush()
                            } else {
                                apiArrived.countDown()
                                output.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".toByteArray())
                                output.flush()
                            }
                        }
                    }
                }
            }
        }
        try {
            val base = "http://127.0.0.1:${socket.localPort}"
            previewIo.execute {
                try {
                    Server(base).downloadShort(shortClipAddress(base, "ABC123", "/api/trips/ABC123/recordings/clip-1"), "test-token", file,
                        { request.isCancelled }, request::trackConnection, request::openOutput)
                    request.ready()
                } catch (_: Exception) { request.cancel() } finally { workerDone.countDown() }
            }
            assertTrue(initialBody.await(2, TimeUnit.SECONDS))
            val partialDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
            while (file.length() < 4 && System.nanoTime() < partialDeadline) Thread.sleep(5)
            assertEquals(4L, file.length())
            val before = System.nanoTime()
            request.cancel()
            assertTrue("cancel must not wait for a blocked socket read", System.nanoTime() - before < TimeUnit.MILLISECONDS.toNanos(250))
            assertFalse(file.exists())
            assertTrue(disconnectCalled.await(1, TimeUnit.SECONDS))
            apiIo.execute { try { Server(base).transcript("ABC123", "test-token") } finally { apiDone.countDown() } }
            assertTrue("API must arrive while clip body is still held", apiArrived.await(1, TimeUnit.SECONDS))
            assertTrue(apiDone.await(1, TimeUnit.SECONDS))
            assertEquals(1L, releaseBody.count)
            releaseBody.countDown()
            assertTrue(workerDone.await(2, TimeUnit.SECONDS))
            assertNull(request.takeFile())
            assertFalse(file.exists())
        } finally {
            releaseBody.countDown(); socket.close(); sockets.forEach { runCatching { it.close() } }
            request.cancel(); previewIo.shutdownNow(); apiIo.shutdownNow(); closeIo.shutdownNow()
            previewIo.awaitTermination(2, TimeUnit.SECONDS); closeIo.awaitTermination(2, TimeUnit.SECONDS)
            serverThread.join(1000); file.delete()
        }
    }
}
