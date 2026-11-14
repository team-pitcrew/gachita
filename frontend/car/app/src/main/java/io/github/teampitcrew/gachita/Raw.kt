package io.github.teampitcrew.gachita

import java.io.BufferedOutputStream
import java.io.Closeable
import java.io.DataOutputStream
import java.io.EOFException
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import javax.crypto.KeyGenerator
import javax.crypto.spec.SecretKeySpec

// 원음(T63): 동의가 유효한 동안 기간 제한 없이 수음한 소리를 차 안에 암호화해 두고, 확정한 장면의 구간만 WAV로 잘라 올린다.
// 화면·SDK와 무관한 것만 둔다(단위 테스트 RawTest.kt). 쓰기는 CaptureService의 읽기 스레드, 자르기는 화면의 통신 스레드.

const val CLIP_BEFORE_MS = 20_000L // 장면에 구간이 없으면 시각 앞 20초 ~ 뒤 10초(T43 장면 후보의 구간과 같음)
const val CLIP_AFTER_MS = 10_000L
const val CLIP_MAX_MS = 60_000L // 장면 구간은 60초 이내(T43). 16 kHz 모노면 1.9 MB로 올리기 한도(5 MB) 안
private const val TAG_BYTES = 28 // GCM: IV 12 + 태그 16

/** 사람이 확정한 장면(GET /api/trips의 moments). from·to는 장면 구간(선택, T43). */
data class Moment(val id: String, val at: Long, val from: Long? = null, val to: Long? = null) {
    /** 자를 구간(epoch ms). 장면 구간이 있으면 그것, 없으면 시각 앞뒤. 60초를 넘지 않게 끝을 자른다. */
    val window: LongRange get() {
        val a = from ?: (at - CLIP_BEFORE_MS)
        val b = to ?: (at + CLIP_AFTER_MS)
        return a..minOf(b, a + CLIP_MAX_MS)
    }
}

private val RAW_NAME = Regex("^audio-([A-Z0-9]+)-(\\d+)-(\\d+)\\.raw$")

/**
 * 수음 한 번(서비스 시작부터 끝까지, 같은 동의 세대, 시각이 어긋나지 않는 동안)이 파일 하나다: audio-<여행>-<세대>-<첫 표본 시각 epoch ms>.raw
 * 머리는 [길이 4바이트][Keystore 키(Seal)로 감싼 데이터 키], 그 뒤로 0.1초 묶음마다 [길이][IV+암호문+태그]. 묶음은 16 kHz 모노 16비트 PCM(STT에 넣은 것과 같음).
 * 데이터 키(AES-256)는 파일마다 새로 만들고 그 키만 Keystore 키로 감싼다. 0.1초마다 Keystore를 부르지 않게.
 * 시각은 첫 표본 시각(기기 시계) + 표본 수 ÷ 16(ms)으로 잰다. 쓰는 쪽이 묶음마다 기기 시계와 견줘 0.25초 넘게 어긋나면(읽기가 멈춤, 시계가 바뀜)
 * 새 파일로 넘어가 시각을 다시 맞춘다(CaptureService.keep).
 */
class RawWriter(dir: File, val trip: String, val generation: Int, val startedAt: Long, seal: Seal) : Closeable {
    val file = File(dir, "audio-$trip-$generation-$startedAt.raw")
    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val data = Seal(key)
    private val head = seal.close(key.encoded) // 키를 먼저 감싼다: 실패하면 파일을 만들지 않는다
    private val out = DataOutputStream(BufferedOutputStream(FileOutputStream(file), 64 * 1024))
    private val pending = java.io.ByteArrayOutputStream(RECORD_BYTES)

    /** 지금까지 받은 표본 수(쓰지 못하고 남은 것 포함). 다음 묶음의 시각 = startedAt + frames ÷ 16 ms. */
    var frames = 0L
        private set

    init {
        runCatching { out.writeInt(head.size); out.write(head); out.flush() }.onFailure { out.close(); file.delete(); throw it }
    }

    /**
     * 묶음(마지막만 빼고 언제나 0.1초 = 1,600표본)을 디스크까지 내보낸다. 수음 중에도 지난 장면을 바로 자를 수 있게.
     * 짧게 읽힌 조각은 모아 다음 조각과 합친다(묶음 자리를 계산으로 바로 찾게).
     */
    fun write(pcm: ByteArray) {
        frames += pcm.size / 2
        pending.write(pcm)
        val buf = pending.toByteArray()
        var i = 0
        while (buf.size - i >= RECORD_BYTES) { seal(buf.copyOfRange(i, i + RECORD_BYTES)); i += RECORD_BYTES }
        pending.reset(); pending.write(buf, i, buf.size - i)
        out.flush()
    }

    private fun seal(pcm: ByteArray) = data.close(pcm).let { out.writeInt(it.size); out.write(it) }

    override fun close() {
        runCatching { if (pending.size() > 0) seal(pending.toByteArray()) } // 꼬리만 짧은 묶음
        out.close()
    }
}

private const val RECORD_BYTES = CHUNK_FRAMES * 2
private const val STRIDE = 4L + TAG_BYTES + RECORD_BYTES

/** 원음 파일 하나. 이름에서 여행·세대·첫 표본 시각을 읽는다. */
class RawFile(val file: File) {
    private val m = RAW_NAME.find(file.name) ?: error("원음 파일 이름이 아님 ${file.name}")
    val trip: String = m.groupValues[1]
    val generation = m.groupValues[2].toInt()
    val startedAt = m.groupValues[3].toLong()

    /** 이 파일이 덮는 끝 시각(어림, 꼬리의 짧은 묶음은 0.1초 안). 머리를 읽지 못하면 시작 시각. */
    val endsAt: Long get() = runCatching {
        RandomAccessFile(file, "r").use { f -> startedAt + (f.length() - 4 - f.readInt()) / STRIDE * 100 }
    }.getOrDefault(startedAt)

    /**
     * [from, to](epoch ms)에 걸친 소리(16 kHz 모노 PCM). 이 파일에 그 시각이 없으면 null. 키가 바뀌어 열리지 않으면 던진다.
     * 묶음은 마지막만 빼고 0.1초라 시작 묶음의 자리로 바로 건너뛰고, 걸친 묶음만 푼다. 쓰다 끊긴 꼬리는 버린다.
     */
    fun cut(seal: Seal, from: Long, to: Long): ByteArray? {
        val a = maxOf(0, (from - startedAt) * RATE / 1000) // 표본 번호
        val b = (to - startedAt) * RATE / 1000
        if (b <= a) return null
        val pcm = java.io.ByteArrayOutputStream()
        RandomAccessFile(file, "r").use { f ->
            try {
                val data = Seal(SecretKeySpec(seal.open(ByteArray(f.readInt()).also { f.readFully(it) }), "AES"))
                val k = a / CHUNK_FRAMES
                val at = f.filePointer + k * STRIDE
                if (at >= f.length()) return null // 이 파일이 끝난 뒤의 시각
                f.seek(at)
                var pos = k * CHUNK_FRAMES
                while (pos < b) {
                    val n = f.readInt()
                    val frames = (n - TAG_BYTES) / 2L
                    val chunk = data.open(ByteArray(n).also { f.readFully(it) })
                    val s = (maxOf(a, pos) - pos).toInt() * 2
                    val e = (minOf(b, pos + frames) - pos).toInt() * 2
                    if (e > s) pcm.write(chunk, s, e - s)
                    pos += frames
                }
            } catch (_: EOFException) {} // 머리를 다 쓰기 전에 끊긴 파일, 쓰다 끊긴 꼬리
        }
        return pcm.toByteArray().takeIf { it.isNotEmpty() }
    }

    companion object {
        fun of(dir: File, trip: String) = dir.listFiles().orEmpty().filter { RAW_NAME.find(it.name)?.groupValues?.get(1) == trip }.map(::RawFile)
    }
}

/**
 * 장면 구간의 원음이 있을 파일 하나: 구간과 가장 많이 겹치는 수음(파일의 끝은 길이로 어림). 겹치는 것이 없으면 null.
 * ponytail: 구간이 수음 두 번에 걸치면(그 사이 서비스가 다시 시작됨) 많이 겹치는 쪽만 자른다.
 */
fun clipFile(files: List<RawFile>, w: LongRange): RawFile? =
    files.map { it to minOf(w.last, it.endsAt) - maxOf(w.first, it.startedAt) }.filter { it.second > 0 }.maxByOrNull { it.second }?.first

/** 올리기를 마쳤거나 버린 장면 id(clips-<여행>.done, 한 줄에 하나). 장면 id는 민감정보가 아니라 평문으로 둔다. */
class ClipLog(dir: File, trip: String) {
    private val file = File(dir, "clips-$trip.done")
    fun done(): Set<String> = if (file.exists()) file.readLines().filter { it.isNotBlank() }.toSet() else emptySet()
    fun add(id: String) = file.appendText("$id\n")
}

/**
 * 원음 파일을 열고 쓰는 것(수음 스레드)과 지우는 것(화면)을 한 줄로 세운다. 수음 스레드가 '멈추는 중이 아님'을 보고 옛 세대 파일을 여는 사이
 * 화면이 철회로 지우기를 끝내 버리면 그 파일이 남기 때문이다. 0.1초 묶음 하나를 쓰는 동안만 잡는다.
 */
val RAW_LOCK = Any()

/** 동의 세대가 바뀌면(동의 철회) 옛 세대의 원음을 지운다. 지운 파일 수. */
fun dropRaw(dir: File, trip: String, below: Int): Int = synchronized(RAW_LOCK) { RawFile.of(dir, trip).count { it.generation < below && it.file.delete() } }

/** 16 kHz 모노 16비트 PCM → WAV(RIFF 머리 44바이트). POST /recordings가 받는 모양. */
fun wav(pcm: ByteArray): ByteArray = ByteBuffer.allocate(44 + pcm.size).order(ByteOrder.LITTLE_ENDIAN).apply {
    put("RIFF".toByteArray()); putInt(36 + pcm.size); put("WAVE".toByteArray())
    put("fmt ".toByteArray()); putInt(16); putShort(1); putShort(1); putInt(RATE); putInt(RATE * 2); putShort(2); putShort(16)
    put("data".toByteArray()); putInt(pcm.size); put(pcm)
}.array()
