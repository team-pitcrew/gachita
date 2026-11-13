package io.github.teampitcrew.gachita

import java.io.BufferedOutputStream
import java.io.Closeable
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import javax.crypto.KeyGenerator
import javax.crypto.spec.SecretKeySpec

// 원음(T63): 사람이 장면을 고를 때까지(여행을 만든 뒤 48시간) 수음한 소리를 차 안에 암호화해 두고, 확정한 장면의 구간만 WAV로 잘라 올린다.
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
 * 수음 한 번(서비스 시작부터 끝까지, 같은 동의 세대)이 파일 하나다: audio-<여행>-<세대>-<첫 표본 시각 epoch ms>.raw
 * 머리는 [길이 4바이트][Keystore 키(Seal)로 감싼 데이터 키], 그 뒤로 0.1초 묶음마다 [길이][IV+암호문+태그]. 묶음은 16 kHz 모노 16비트 PCM(STT에 넣은 것과 같음).
 * 데이터 키(AES-256)는 파일마다 새로 만들고 그 키만 Keystore 키로 감싼다. 0.1초마다 Keystore를 부르지 않게.
 * 시각은 첫 표본 시각 + 표본 수 ÷ 16(ms)으로 잰다. ponytail: 녹음 시계와 기기 시계의 어긋남은 고치지 않는다(1시간 시험에서 잼). 클립 앞뒤 여유로 덮는다.
 */
class RawWriter(dir: File, val trip: String, val generation: Int, val startedAt: Long, seal: Seal) : Closeable {
    val file = File(dir, "audio-$trip-$generation-$startedAt.raw")
    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val data = Seal(key)
    private val out = DataOutputStream(BufferedOutputStream(FileOutputStream(file), 64 * 1024))

    init { seal.close(key.encoded).let { out.writeInt(it.size); out.write(it) } }

    /** 묶음마다 디스크까지 내보낸다. 수음 중에도 지난 장면을 바로 자를 수 있게. */
    fun write(pcm: ByteArray) = data.close(pcm).let { out.writeInt(it.size); out.write(it); out.flush() }

    override fun close() = out.close()
}

/** 원음 파일 하나. 이름에서 여행·세대·첫 표본 시각을 읽는다. */
class RawFile(val file: File) {
    private val m = RAW_NAME.find(file.name) ?: error("원음 파일 이름이 아님 ${file.name}")
    val trip: String = m.groupValues[1]
    val generation = m.groupValues[2].toInt()
    val startedAt = m.groupValues[3].toLong()

    /**
     * [from, to](epoch ms)에 걸친 소리(16 kHz 모노 PCM). 이 파일에 그 시각이 없으면 null.
     * 묶음의 길이만 보고 건너뛰고 걸친 묶음만 푼다. 쓰다 끊긴 꼬리는 버린다. 키가 바뀌어 열리지 않으면 던진다.
     */
    fun cut(seal: Seal, from: Long, to: Long): ByteArray? {
        val a = maxOf(0, (from - startedAt) * RATE / 1000) // 표본 번호
        val b = (to - startedAt) * RATE / 1000
        if (b <= a) return null
        val pcm = java.io.ByteArrayOutputStream()
        DataInputStream(file.inputStream()).use { input -> // 버퍼 없이: 건너뛰는 묶음은 길이만 읽고 lseek로 넘긴다
            val data = Seal(SecretKeySpec(seal.open(ByteArray(input.readInt()).also { input.readFully(it) }), "AES"))
            var pos = 0L
            try {
                while (pos < b) {
                    val n = input.readInt()
                    val frames = (n - TAG_BYTES) / 2L
                    if (pos + frames <= a) { skip(input, n); pos += frames; continue }
                    val chunk = data.open(ByteArray(n).also { input.readFully(it) })
                    val s = (maxOf(a, pos) - pos).toInt() * 2
                    val e = (minOf(b, pos + frames) - pos).toInt() * 2
                    pcm.write(chunk, s, e - s)
                    pos += frames
                }
            } catch (_: EOFException) {} // 쓰다 끊긴 꼬리
        }
        return pcm.toByteArray().takeIf { it.isNotEmpty() }
    }

    private fun skip(input: DataInputStream, n: Int) {
        var left = n
        while (left > 0) input.skipBytes(left).also { if (it <= 0) throw EOFException(); left -= it }
    }

    companion object {
        fun of(dir: File, trip: String) = dir.listFiles().orEmpty().filter { RAW_NAME.find(it.name)?.groupValues?.get(1) == trip }.map(::RawFile)
    }
}

/**
 * 장면 구간의 원음이 있을 파일 하나: 구간 시작 전에 시작한 수음 가운데 가장 늦은 것, 없으면 구간 안에서 시작한 가장 이른 것.
 * ponytail: 구간이 수음 두 번에 걸치면(그 사이 서비스가 다시 시작됨) 한쪽만 자른다.
 */
fun clipFile(files: List<RawFile>, w: LongRange): RawFile? =
    files.filter { it.startedAt <= w.first }.maxByOrNull { it.startedAt } ?: files.filter { it.startedAt in w }.minByOrNull { it.startedAt }

/** 올리기를 마쳤거나 버린 장면 id(clips-<여행>.done, 한 줄에 하나). 장면 id는 민감정보가 아니라 평문으로 둔다. */
class ClipLog(dir: File, trip: String) {
    private val file = File(dir, "clips-$trip.done")
    val done: Set<String> get() = if (file.exists()) file.readLines().filter { it.isNotBlank() }.toSet() else emptySet()
    fun add(id: String) = file.appendText("$id\n")
}

/** 동의 세대가 바뀌면(동의 철회) 옛 세대의 원음을 지운다. 지운 파일 수. */
fun dropRaw(dir: File, trip: String, below: Int): Int = RawFile.of(dir, trip).count { it.generation < below && it.file.delete() }

/** 16 kHz 모노 16비트 PCM → WAV(RIFF 머리 44바이트). POST /recordings가 받는 모양. */
fun wav(pcm: ByteArray): ByteArray = ByteBuffer.allocate(44 + pcm.size).order(ByteOrder.LITTLE_ENDIAN).apply {
    put("RIFF".toByteArray()); putInt(36 + pcm.size); put("WAVE".toByteArray())
    put("fmt ".toByteArray()); putInt(16); putShort(1); putShort(1); putInt(RATE); putInt(RATE * 2); putShort(2); putShort(16)
    put("data".toByteArray()); putInt(pcm.size); put(pcm)
}.array()
