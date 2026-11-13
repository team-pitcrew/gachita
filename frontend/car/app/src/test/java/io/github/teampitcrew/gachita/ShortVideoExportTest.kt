package io.github.teampitcrew.gachita

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CancellationException

class ShortVideoExportTest {
    private fun chunk(name: String, bytes: ByteArray): ByteArray = ByteArrayOutputStream().apply {
        write(name.toByteArray(Charsets.US_ASCII))
        write(ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(bytes.size).array())
        write(bytes)
        if (bytes.size % 2 != 0) write(0)
    }.toByteArray()

    private fun wav(pcm: ByteArray, rate: Int = 16_000, dataFirst: Boolean = false): ByteArray {
        val fmt = ByteBuffer.allocate(16).order(ByteOrder.LITTLE_ENDIAN)
            .putShort(1).putShort(1).putInt(rate).putInt(rate * 2).putShort(2).putShort(16).array()
        val data = chunk("data", pcm)
        val body = "WAVE".toByteArray() + chunk("JUNK", byteArrayOf(7, 8, 9)) +
            if (dataFirst) data + chunk("fmt ", fmt) else chunk("fmt ", fmt) + data
        return "RIFF".toByteArray() + ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(body.size).array() + body
    }

    private fun withWav(bytes: ByteArray, action: (File) -> Unit) {
        val file = File.createTempFile("short-export-test-", ".wav")
        try { file.writeBytes(bytes); action(file) } finally { file.delete() }
    }

    @Test fun readsPcmPastOddMetadataAndDoesNotAssumeChunkOrder() {
        val pcm = byteArrayOf(0, 1, 2, 3, 4, 5)
        for (dataFirst in listOf(false, true)) withWav(wav(pcm, dataFirst = dataFirst)) {
            assertArrayEquals(pcm, readExportPcm(it, 100))
            assertArrayEquals(pcm.take(4).toByteArray(), readExportPcm(it, 4))
            assertTrue("Caller still owns input", it.exists())
        }
    }

    @Test fun rejectsUnsupportedRateInsteadOfChangingTheRecordedVoice() {
        withWav(wav(byteArrayOf(1, 2), rate = 48_000)) { file ->
            assertThrows(IllegalArgumentException::class.java) { readExportPcm(file, 100) }
        }
    }

    @Test fun rejectsTruncatedAudioInsteadOfExportingSilentSuccess() {
        withWav(wav(byteArrayOf(1, 2, 3, 4)).dropLast(2).toByteArray()) { file ->
            assertThrows(IllegalArgumentException::class.java) { readExportPcm(file, 100) }
        }
    }

    @Test fun limitsTimelineToFirst45SecondsAndPreservesSceneOffsets() {
        val scene = Scene("대화", "/clip", 30.0, emptyList())
        withWav(wav(ByteArray(16_000 * 2 * 30) { 42 })) { first ->
            withWav(wav(ByteArray(16_000 * 2 * 30) { 17 })) { second ->
                val parts = exportTimeline(Short("여행", listOf(scene, scene)), listOf(first, second), ShortExportControl())
                assertEquals(listOf(0L, 30_000_000L), parts.map { it.startUs })
                assertEquals(listOf(30_000_000L, 15_000_000L), parts.map { it.durationUs })
                assertTrue(parts[0].pcm.all { it == 42.toByte() })
                assertTrue(parts[1].pcm.all { it == 17.toByte() })
            }
        }
    }

    @Test fun cancellationPreventsReadingAndPublishing() {
        val control = ShortExportControl().apply { cancel() }
        assertTrue(control.isCancelled)
        assertThrows(CancellationException::class.java) { control.publish { fail("Must not publish") } }
        val scene = Scene("대화", "/clip", 1.0, emptyList())
        assertThrows(CancellationException::class.java) {
            exportTimeline(Short("여행", listOf(scene)), listOf(File("does-not-exist")), control)
        }
    }

    @Test fun deniedFinalPermissionNeverPublishes() {
        val events = mutableListOf<String>()
        val control = ShortExportControl()
        assertThrows(SecurityException::class.java) {
            control.publishAfter({ events += "verify"; throw SecurityException("consent revoked") }) { events += "publish" }
        }
        assertEquals(listOf("verify"), events)
    }

    @Test fun cancelDuringFinalPermissionCheckStillPreventsPublication() {
        val events = mutableListOf<String>()
        val control = ShortExportControl()
        assertThrows(CancellationException::class.java) {
            control.publishAfter({ events += "verify"; control.cancel() }) { events += "publish" }
        }
        assertEquals(listOf("verify"), events)
        assertTrue(control.isCancelled)
    }
}
