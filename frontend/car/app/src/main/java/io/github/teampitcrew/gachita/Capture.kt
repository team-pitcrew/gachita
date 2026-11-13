package io.github.teampitcrew.gachita

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

// 수음과 받아쓰기에서 화면·SDK와 무관한 것(단위 테스트 CaptureTest.kt). 안드로이드 쪽은 CaptureService.kt.

const val RATE = 16_000 // 16 kHz 2채널로 수음하고 STT에는 16 kHz 모노를 넣는다(11/13 실측과 같음)
const val CHUNK_FRAMES = RATE / 10 // 0.1초
const val LEAD_MS = 1_000L // 첫 중간 결과는 말 시작 0.4~0.8초 뒤에 왔다(11/13). 발화 시작은 그만큼 앞으로 잡는다
const val ZERO_CHUNKS = 10 // 값이 모두 0인 조각이 1초 이어지면 막힘
const val STALL_MS = 2_000L // read()가 2초 넘게 돌아오지 않으면 막힘

const val FIX_MS = 30_000L // 이보다 오래된 위치는 발화에 붙이지 않는다(위치는 10초마다 묻는다)

/** 내비가 알려 준 위치와 그때의 시각(epoch ms). */
data class Fix(val lat: Double, val lng: Double, val at: Long)

/**
 * 받아 적은 말 한 건. 시각은 epoch ms. 원음 구간은 이번 수음 시작부터 센 샘플 위치(ms)이고 원음 자체는 두지 않는다(T12).
 * generation은 받아 적을 때의 동의 세대(서버 여행의 generation). seatZone(0 앞줄, 1 뒷줄, 모르면 null)은 T37이 채운다.
 * 서버에 올리는 칸(wire)은 POST /api/trips/{code}/utterances의 items와 같고, 끝 시각·원음 구간·좌석 구역은 차에만 둔다.
 * ponytail: 서버 seatArea는 좌석 하나라 구역(줄)을 넣을 칸이 없다. T37에서 서버와 맞추면 wire에 더한다.
 */
data class Utterance(
    val seq: Long, val trip: String, val startedAt: Long, val endedAt: Long, val text: String,
    val audioFromMs: Long, val audioToMs: Long, val generation: Int,
    val lat: Double? = null, val lng: Double? = null, val seatZone: Int? = null,
) {
    /** 보관함의 한 줄(차 안). */
    fun json(): JSONObject = JSONObject().put("seq", seq).put("trip", trip).put("at", startedAt).put("endedAt", endedAt).put("text", text)
        .put("audioFromMs", audioFromMs).put("audioToMs", audioToMs).put("generation", generation).apply {
            if (lat != null && lng != null) put("lat", lat).put("lng", lng)
            seatZone?.let { put("seatZone", it) }
        }

    /**
     * 서버에 올리는 모양. 지금 세대(current)보다 옛 세대면 내용 없이 순번과 세대만(ADR-0014 2절).
     * 서버가 묶음 전체를 400으로 거절하면 확인 순번이 그 앞에서 멈추므로, 서버 검사에 걸리지 않게 다듬는다:
     * 글은 500자에서 자르되 이모지를 반으로 가르지 않고, 세대는 서버의 지금 세대를 넘지 않는다(DB를 되살려 세대가 내려간 경우).
     */
    fun wire(current: Int): JSONObject {
        val g = minOf(generation, current)
        val o = JSONObject().put("seq", seq).put("generation", g)
        if (g < current) return o
        val t = text.trim()
        o.put("at", startedAt).put("text", if (t.length <= 500) t else t.take(if (t[499].isHighSurrogate()) 499 else 500))
        if (lat != null && lng != null) o.put("lat", lat).put("lng", lng)
        return o
    }

    companion object {
        fun parse(line: String): Utterance = JSONObject(line).let { o ->
            Utterance(
                o.getLong("seq"), o.getString("trip"), o.getLong("at"), o.getLong("endedAt"), o.optString("text"),
                o.getLong("audioFromMs"), o.getLong("audioToMs"), o.getInt("generation"),
                if (o.has("lat")) o.getDouble("lat") else null, if (o.has("lng")) o.getDouble("lng") else null, if (o.has("seatZone")) o.getInt("seatZone") else null,
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

/** 보관함의 발화를 서버로 보내는 쪽(POST /api/trips/{code}/utterances). 서버가 1부터 빠짐없이 받은 마지막 순번(lastSeq). 못 보내면 던진다. */
fun interface Uplink {
    fun send(device: String, items: JSONArray): Long
}

/**
 * 보관함: 여행 하나의 발화를 순번(1부터)과 함께 앱 저장소에 한 줄씩(JSON lines) 쌓는다. 앱을 다시 켜면 파일에서 이어 읽는다.
 * acked는 서버가 1부터 빠짐없이 받았다고 한 마지막 순번(lastSeq)이고, 그 뒤의 것만 보낸다.
 * 서버가 돌려준 값이 acked보다 작으면(DB를 백업에서 되살림) 그 값으로 내리고 그 뒤부터 다시 보낸다(ADR-0014 2절).
 * 동의 세대가 바뀌면(동의 철회) 옛 세대 발화의 글과 위치를 지우고 순번과 세대만 남긴다. 서버에도 그것만 보내 확인받는다.
 * 쓰기(수음 서비스, 메인 스레드)와 보내기(통신 스레드)가 갈라져 있어 목록은 잠금 안에서만 만진다. 보내는 동안은 잠그지 않는다.
 * ponytail: 여행마다 파일 하나, 지우지 않는다. 암호화와 48시간 뒤 지우기는 T69.
 */
class Outbox(dir: File, val trip: String) {
    private val file = File(dir, "utterances-$trip.jsonl")
    private val ackFile = File(dir, "utterances-$trip.acked")
    private val items = mutableListOf<Utterance>()
    var acked = 0L
        private set

    /** 지금 동의 세대. 새 발화에 붙인다. 화면이 서버 여행을 받을 때마다 see()로 맞춘다. */
    @Volatile var generation = 1
        private set
    private var before = 1 // 바로 앞 세대
    private var bumpedAt = 0L // 세대가 오른 것을 안 시각

    init {
        if (file.exists()) {
            file.forEachLine { line -> runCatching { Utterance.parse(line) }.getOrNull()?.let { items += it } } // 쓰다 끊긴 줄은 건너뜀
            if (file.length() > 0 && !file.readText().endsWith("\n")) file.appendText("\n") // 끊긴 줄 뒤에 붙여 쓰지 않게
        }
        acked = runCatching { ackFile.readText().trim().toLong() }.getOrDefault(0L)
        generation = items.maxOfOrNull { it.generation } ?: 1
    }

    private val said get() = items.filter { it.text.isNotEmpty() }
    val size: Int @Synchronized get() = said.size
    val pending: Int @Synchronized get() = items.count { it.seq > acked }

    @Synchronized fun recent(n: Int): List<Utterance> = said.takeLast(n)

    /**
     * 위치는 발화 끝에서 FIX_MS 안에 받은 것만 붙인다. 세대가 오른 것을 알기 전에 시작한 말(동의 철회 사이에 한 말일 수 있음)은
     * 앞 세대로, 글 없이 남긴다(폰에서 끄고 10초 조회 안에 다시 켜 기록이 이어진 경우).
     */
    @Synchronized fun add(d: Draft, fix: Fix?): Utterance {
        val old = d.startedAt < bumpedAt
        val f = fix?.takeIf { !old && kotlin.math.abs(d.endedAt - it.at) <= FIX_MS }
        val u = Utterance((items.lastOrNull()?.seq ?: 0) + 1, trip, d.startedAt, d.endedAt, if (old) "" else d.text, d.audioFromMs, d.audioToMs,
            if (old) before else generation, f?.lat, f?.lng)
        file.appendText(u.json().toString() + "\n")
        items += u
        return u
    }

    /** 서버 여행의 동의 세대. 올라갔으면 옛 세대 발화의 내용을 지운다(임시 파일에 다 쓴 뒤 이름을 바꿈). 지운 것이 있으면 true. */
    @Synchronized fun see(g: Int): Boolean {
        if (g < generation) generation = g // 서버 DB를 백업에서 되살림: 서버의 세대를 따른다(넘는 세대로 보내면 400)
        if (g <= generation) return false
        before = generation; generation = g; bumpedAt = System.currentTimeMillis()
        if (items.none { it.generation < g && it.text.isNotEmpty() }) return false
        for (i in items.indices) if (items[i].generation < g) items[i] = items[i].copy(text = "", lat = null, lng = null)
        val tmp = File(file.path + ".tmp") // 바꾸지 못하면 앞의 파일이 남는다. 다시 켜면 세대를 다시 받아 또 지운다
        runCatching { tmp.writeText(items.joinToString("") { it.json().toString() + "\n" }); tmp.renameTo(file) }
        return true
    }

    /** 받지 않은 것을 max건까지 보낸다. 통신 스레드에서 부른다. 보낸 뒤 서버가 받았다고 한 데까지로 acked를 맞춘다. */
    fun flush(up: Uplink, device: String, max: Int = 100) {
        val (batch, g) = synchronized(this) { items.filter { it.seq > acked }.take(max) to generation }
        if (batch.isEmpty()) return
        val got = up.send(device, JSONArray(batch.map { it.wire(g) }))
        synchronized(this) {
            if (got != acked) { acked = got; ackFile.writeText(got.toString()) }
        }
    }
}
