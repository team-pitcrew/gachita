package io.github.teampitcrew.gachita

import org.json.JSONObject
import java.io.File

// 수음과 받아쓰기에서 화면·SDK와 무관한 것(단위 테스트 CaptureTest.kt). 안드로이드 쪽은 CaptureService.kt.

const val RATE = 16_000 // 16 kHz 2채널로 수음하고 STT에는 16 kHz 모노를 넣는다(11/13 실측과 같음)
const val CHUNK_FRAMES = RATE / 10 // 0.1초
const val LEAD_MS = 1_000L // 첫 중간 결과는 말 시작 0.4~0.8초 뒤에 왔다(11/13). 발화 시작은 그만큼 앞으로 잡는다
const val ZERO_CHUNKS = 10 // 값이 모두 0인 조각이 1초 이어지면 막힘
const val STALL_MS = 2_000L // read()가 2초 넘게 돌아오지 않으면 막힘

/**
 * 받아 적은 말 한 건. 시각은 epoch ms. 원음 구간은 이번 수음 시작부터 센 샘플 위치(ms)이고 원음 자체는 두지 않는다(T12).
 * seatZone은 자리만 둔다(T37이 채움). 위치(FusedLocation)는 아직 붙이지 않는다.
 */
data class Utterance(
    val seq: Long, val trip: String, val startedAt: Long, val endedAt: Long, val text: String,
    val audioFromMs: Long, val audioToMs: Long, val gear: String?, val seatZone: Int? = null,
) {
    fun json(): JSONObject = JSONObject().put("seq", seq).put("trip", trip).put("started_at", startedAt).put("ended_at", endedAt)
        .put("text", text).put("seat_zone", seatZone ?: JSONObject.NULL).put("gear", gear ?: JSONObject.NULL)
        .put("audio", JSONObject().put("from_ms", audioFromMs).put("to_ms", audioToMs))

    companion object {
        fun parse(line: String): Utterance = JSONObject(line).let { o ->
            val a = o.getJSONObject("audio")
            Utterance(
                o.getLong("seq"), o.getString("trip"), o.getLong("started_at"), o.getLong("ended_at"), o.getString("text"),
                a.getLong("from_ms"), a.getLong("to_ms"), if (o.isNull("gear")) null else o.getString("gear"),
                if (o.isNull("seat_zone")) null else o.getInt("seat_zone"),
            )
        }
    }
}

/** STT에 넣을 0.1초 모노(16비트 LE)와, 두 채널 값이 모두 0이었는지. */
class Chunk(val mono: ByteArray, val allZero: Boolean)

/**
 * 2채널 인터리브(좌, 우, 좌, 우…) 값 n개를 좌+우 모노로 합친다. 넘치면 자른다.
 * ponytail: 더하기는 11/13 실측과 같은 방식. 에뮬레이터는 두 채널이 완전히 갈려 넘치지 않았다.
 * 실차에서 두 채널에 같은 소리가 크게 들어와 잘리면 평균((좌+우)/2)으로 바꾼다.
 */
fun downmix(buf: ShortArray, n: Int): Chunk {
    val out = ByteArray(n / 2 * 2)
    var zero = true
    var i = 0
    while (i + 1 < n) {
        val l = buf[i].toInt(); val r = buf[i + 1].toInt()
        if (l != 0 || r != 0) zero = false
        val m = (l + r).coerceIn(-32768, 32767)
        out[i] = m.toByte(); out[i + 1] = (m shr 8).toByte() // 모노 표본 하나 = 2바이트 = 입력 값 둘의 자리
        i += 2
    }
    return Chunk(out, zero)
}

/** 묶기가 만든 발화. 순번과 여행은 보관함이 붙인다. */
data class Draft(val startedAt: Long, val endedAt: Long, val text: String, val audioFromMs: Long, val audioToMs: Long)

/**
 * STT 결과를 발화로 묶는다. 첫 중간 결과에서 열고 최종 결과에서 닫는다.
 * onStartedRecognition은 최종 결과 바로 앞에 와서(11/13) 시작 시각으로 쓰지 않는다.
 * now는 시계(epoch ms), audioMs는 수음 시작부터 읽은 원음 길이.
 */
class Assembler {
    private var openAt = -1L
    private var openAudio = 0L

    fun partial(now: Long, audioMs: Long) {
        if (openAt < 0) { openAt = now - LEAD_MS; openAudio = maxOf(0, audioMs - LEAD_MS) }
    }

    /** 최종 결과. 글자가 비면 null. 중간 결과 없이 최종이 바로 와도 같은 방식으로 연다. */
    fun final(text: String, now: Long, audioMs: Long): Draft? {
        partial(now, audioMs)
        val d = Draft(openAt, now, text.trim(), openAudio, audioMs)
        openAt = -1
        return d.takeIf { it.text.isNotEmpty() }
    }
}

/**
 * 수음이 막혔는지(T10 실측). 셋 중 하나면 막힘: 시스템이 우리 녹음을 막음(isClientSilenced),
 * 값이 모두 0인 조각이 1초 이어짐(막히지 않은 무음은 약 −77 dBFS 잡음이라 0이 아님), read()가 2초 넘게 돌아오지 않음.
 * 막힘은 오류로 오지 않는다. 0이 이어지다가 read()가 돌아오지 않게 된다.
 */
class Blockage(startedAt: Long) {
    @Volatile var silenced = false
    private var zeros = 0
    private var lastChunk = startedAt

    fun chunk(allZero: Boolean, now: Long) { lastChunk = now; zeros = if (allZero) zeros + 1 else 0 }

    /** 막힌 까닭(silenced, zeros, stall). 막히지 않았으면 null. */
    fun reason(now: Long): String? = when {
        silenced -> "silenced"
        zeros >= ZERO_CHUNKS -> "zeros"
        now - lastChunk >= STALL_MS -> "stall"
        else -> null
    }
}

/** 보관함의 발화를 서버로 보내는 쪽. 서버가 1부터 빠짐없이 받은 마지막 순번을 돌려주고, 못 보냈으면 null. */
fun interface Uplink {
    fun send(trip: String, device: String, items: List<Utterance>): Long?
}

/** 발화 저장 API(T39)가 생기기 전까지 꽂아 두는 쪽: 보내지 않고 보관함에 쌓아 둔다. */
val KEEP = Uplink { _, _, _ -> null }

/**
 * 보관함: 여행 하나의 발화를 순번(1부터)과 함께 앱 저장소에 한 줄씩(JSON lines) 쌓는다. 앱을 다시 켜면 파일에서 이어 읽는다.
 * acked는 서버가 1부터 빠짐없이 받았다고 한 마지막 순번(ADR-0014 초안, PR #82)이고, 그 뒤의 것만 보낸다.
 * 쓰기(수음 서비스, 메인 스레드)와 보내기(통신 스레드)가 갈라져 있어 목록은 잠금 안에서만 만진다. 보내는 동안은 잠그지 않는다.
 * ponytail: 여행마다 파일 하나, 지우지 않는다. 차 안 보관 기간은 T12·T39에서 정하면 넣는다.
 */
class Outbox(dir: File, val trip: String) {
    private val file = File(dir, "utterances-$trip.jsonl")
    private val ackFile = File(dir, "utterances-$trip.acked")
    private val items = mutableListOf<Utterance>()
    var acked = 0L
        private set

    init {
        if (file.exists()) {
            file.forEachLine { line -> runCatching { Utterance.parse(line) }.getOrNull()?.let { items += it } } // 쓰다 끊긴 줄은 건너뜀
            if (file.length() > 0 && !file.readText().endsWith("\n")) file.appendText("\n") // 끊긴 줄 뒤에 붙여 쓰지 않게
        }
        acked = runCatching { ackFile.readText().trim().toLong() }.getOrDefault(0L)
    }

    val size: Int @Synchronized get() = items.size
    val pending: Int @Synchronized get() = items.count { it.seq > acked }

    @Synchronized fun recent(n: Int): List<Utterance> = items.takeLast(n)

    @Synchronized fun add(d: Draft, gear: String?): Utterance {
        val u = Utterance((items.lastOrNull()?.seq ?: 0) + 1, trip, d.startedAt, d.endedAt, d.text, d.audioFromMs, d.audioToMs, gear)
        file.appendText(u.json().toString() + "\n")
        items += u
        return u
    }

    /** 받지 않은 것을 max건까지 보낸다. 통신 스레드에서 부른다. 보낸 뒤 서버가 받았다고 한 데까지 acked를 올린다. */
    fun flush(up: Uplink, device: String, max: Int = 100) {
        val batch = synchronized(this) { items.filter { it.seq > acked }.take(max) }
        if (batch.isEmpty()) return
        val got = up.send(trip, device, batch) ?: return
        synchronized(this) {
            if (got > acked) { acked = got; ackFile.writeText(got.toString()) }
        }
    }
}
