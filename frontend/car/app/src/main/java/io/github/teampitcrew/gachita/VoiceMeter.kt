package io.github.teampitcrew.gachita

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.io.ByteArrayOutputStream
import kotlin.math.log10
import kotlin.math.sqrt

// 목소리 등록 파형(T142 C06·C07, T133 아이 목소리): 막대가 실제로 들어온 소리를 따른다.
// 수음과 같은 0.1초 조각의 채널별 에너지(downmix의 Chunk.left·right — Capture.kt Levels가 좌석 구역에 쓰는 그 값)로 RMS를 내고,
// 막대 칸마다 그 칸 동안의 평균을 적는다. 지난 칸은 멈추고, 지금 칸은 소리를 따라 움직이고, 앞으로 칸은 비어 있다.
// 웹(frontend/web/voice-meter.js)과 같은 눈금(−55 dBFS → 0, −5 dBFS → 1)이다.

/** 0.1초 조각의 RMS(−1~1 눈금). n은 downmix에 넣은 2채널 값의 수. */
fun chunkRms(c: Chunk, n: Int): Double = if (n <= 0) 0.0 else sqrt((c.left + c.right) / n) / 32768.0

/** RMS를 막대 높이 비율(0~1)로. */
fun meterLevel(rms: Double): Double = if (rms <= 0) 0.0 else ((20 * log10(rms) + 55) / 50).coerceIn(0.0, 1.0)

/** seconds초를 slots칸으로 나눠 칸마다 평균 소리 크기를 둔다. 녹음 스레드가 add, 화면이 levels를 읽는다. */
class VoiceMeter(val slots: Int, private val seconds: Double = VOICE_SECONDS.toDouble()) {
    private val sums = DoubleArray(slots)
    private val counts = IntArray(slots)
    private val levels = DoubleArray(slots)

    fun slotAt(elapsed: Double): Int = minOf(slots, (elapsed.coerceAtLeast(0.0) / seconds * slots).toInt())

    /** elapsed초에 잰 level(0~1)을 그 칸의 평균에 더한다. 범위 밖은 버린다. */
    @Synchronized fun add(elapsed: Double, level: Double) {
        val i = slotAt(elapsed)
        if (i !in 0 until slots) return
        sums[i] += level; counts[i] += 1; levels[i] = sums[i] / counts[i]
    }

    @Synchronized fun snapshot(): DoubleArray = levels.copyOf()
}

/**
 * 목소리 등록 15초 녹음(본인 C06·C07, 아이 C12·C42). 수음(CaptureService)과 같은 형식(MIC, 16 kHz 2채널)을 열어 downmix의 모노를 모으고,
 * 0.1초 조각마다 progress(지난 초, 그 조각의 막대 비율)를 녹음 스레드에서 부른다. done(모노 PCM, 실패 문구)은 끝날 때 한 번.
 * 여행이 없을 때(온보딩·가족 화면)만 쓰므로 수음 서비스와 마이크를 다투지 않는다. 소리는 차를 떠나지 않는다(값만 올림, ADR-0023).
 */
class VoiceRecorder(private val progress: (Double, Double) -> Unit, private val done: (ByteArray, String?) -> Unit) {
    @Volatile private var stop = false
    @Volatile private var cancelled = false
    fun start() = Thread {
        val mask = AudioFormat.CHANNEL_IN_STEREO
        val enc = AudioFormat.ENCODING_PCM_16BIT
        val out = ByteArrayOutputStream()
        val r = try {
            AudioRecord(MediaRecorder.AudioSource.MIC, RATE, mask, enc, maxOf(AudioRecord.getMinBufferSize(RATE, mask, enc) * 4, RATE * 2))
                .also { check(it.state == AudioRecord.STATE_INITIALIZED) }
        } catch (t: Throwable) { done(ByteArray(0), "지금은 마이크를 열 수 없어요"); return@Thread }
        try {
            r.startRecording()
            val buf = ShortArray(CHUNK_FRAMES * 2)
            while (!stop && !cancelled && out.size() < VOICE_SECONDS * RATE * 2) {
                val n = r.read(buf, 0, buf.size)
                if (n <= 0) continue
                val c = downmix(buf, n)
                out.write(c.mono)
                progress(out.size() / 2.0 / RATE, meterLevel(chunkRms(c, n))) // 조각의 실제 크기로 막대를 그린다
            }
        } finally { runCatching { r.stop() }; r.release() }
        if (!cancelled) done(out.toByteArray().copyOf(minOf(out.size(), VOICE_SECONDS * RATE * 2)), null)
    }.start()
    /** 지금까지 모은 것으로 끝낸다(done이 불린다). */
    fun finishNow() { stop = true }
    /** 버린다(done을 부르지 않는다). */
    fun cancel() { cancelled = true }
}
