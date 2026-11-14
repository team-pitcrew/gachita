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
     * 글을 지운 발화(동의 철회)는 지금 세대로는 보낼 수 없어(서버가 글을 요구) 앞 세대로 순번만 보내 확인받고,
     * 서버가 세대 1로 되살아나 앞 세대가 없으면 보내지 않는다(null). 그러면 같은 묶음의 다른 발화는 막히지 않는다.
     */
    fun wire(current: Int): JSONObject? {
        val g = minOf(generation, current)
        if (text.isBlank() && g >= current) return if (current > 1) JSONObject().put("seq", seq).put("generation", current - 1) else null
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

/** STT에 넣을 0.1초 모노(16비트 LE), 두 채널 값이 모두 0이었는지, 채널별 에너지(표본 제곱의 합, 좌석 구역 T37). */
class Chunk(val mono: ByteArray, val allZero: Boolean, val left: Double = 0.0, val right: Double = 0.0)

/**
 * 2채널 인터리브(좌, 우, 좌, 우…) 값 n개를 좌+우 모노로 합친다. 넘치면 자른다. 합치기 전 채널별 에너지를 따로 센다(합치면 어느 쪽 소리였는지 잃음).
 * ponytail: 더하기는 11/13 실측과 같은 방식. 에뮬레이터는 두 채널이 완전히 갈려 넘치지 않았다.
 * 실차에서 두 채널에 같은 소리가 크게 들어와 잘리면 평균((좌+우)/2)으로 바꾼다.
 */
fun downmix(buf: ShortArray, n: Int): Chunk {
    val out = ByteArray(n / 2 * 2)
    var zero = true
    var el = 0.0; var er = 0.0
    var i = 0
    while (i + 1 < n) {
        val l = buf[i].toInt(); val r = buf[i + 1].toInt()
        if (l != 0 || r != 0) zero = false
        el += l.toDouble() * l; er += r.toDouble() * r
        val m = (l + r).coerceIn(-32768, 32767)
        out[i] = m.toByte(); out[i + 1] = (m shr 8).toByte() // 모노 표본 하나 = 2바이트 = 입력 값 둘의 자리
        i += 2
    }
    return Chunk(out, zero, el, er)
}

// 좌석 구역(T37): 발화 구간의 두 채널 크기를 견줘 앞줄(0)·뒷줄(1)·모름(null).
// ponytail: 채널과 줄의 짝, 문턱은 에뮬레이터 기준이다(왼쪽 = 앞줄, 두 채널이 완전히 갈려 60 dB 차, 11/13). 실차의 마이크 수·배치를 보고 이 두 값을 고친다.
const val LEFT_IS_FRONT = true
const val ZONE_DB = 6.0 // 두 채널 크기 차가 이보다 작으면 모름

fun zoneOf(left: Double, right: Double): Int? {
    if (left + right <= 0) return null
    val db = 10 * kotlin.math.log10((left + 1) / (right + 1))
    val front = if (LEFT_IS_FRONT) 0 else 1
    return when {
        db >= ZONE_DB -> front
        db <= -ZONE_DB -> 1 - front
        else -> null
    }
}

/** 최근 60초 묶음(0.1초)의 채널별 에너지. 발화의 원음 구간(수음 시작부터 ms)을 더해 구역을 낸다. 읽기 스레드가 쓰고 메인 스레드가 읽는다. */
class Levels(private val size: Int = 600) {
    private val l = DoubleArray(size)
    private val r = DoubleArray(size)
    private var last = -1L

    /** index는 수음 시작부터 센 묶음 번호(0부터). 짧게 읽힌 조각이 같은 번호로 다시 오면 더한다. */
    @Synchronized fun add(index: Long, left: Double, right: Double) {
        val i = (index % size).toInt()
        if (index == last) { l[i] += left; r[i] += right } else { l[i] = left; r[i] = right }
        last = index
    }

    @Synchronized fun zone(fromMs: Long, toMs: Long): Int? {
        val a = maxOf(fromMs / 100, last - size + 1, 0)
        val b = minOf(toMs / 100, last)
        if (b < a) return null
        var sl = 0.0; var sr = 0.0
        for (k in a..b) { sl += l[(k % size).toInt()]; sr += r[(k % size).toInt()] }
        return zoneOf(sl, sr)
    }
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
 * 보관함: 여행 하나의 발화를 순번(1부터)과 함께 앱 저장소에 한 줄씩 쌓는다. 줄마다 AES-GCM으로 암호화한 Base64 한 줄이다(Vault.kt, T69).
 * 앱을 다시 켜면 풀어서 이어 읽는다. 열리지 않는 줄(쓰다 끊김, 키가 바뀜)은 건너뛴다.
 * 상태 파일(.acked, 암호화)에는 서버가 1부터 빠짐없이 받았다고 한 마지막 순번(lastSeq), 여행을 만든 시각,
 * 동의 철회로 글을 지운 경계 순번을 둔다.
 * 서버가 돌려준 값이 acked보다 작으면(DB를 백업에서 되살림) 그 값으로 내리고 그 뒤부터 다시 보낸다(ADR-0014 2절).
 * 동의 철회(서버 여행의 세대가 오름)를 알게 되면 그때까지 쌓인 순번의 글과 위치를 모두 지우고 그 경계를 남긴다. 다시 켜도 그 경계로만 지운다
 * (세대를 견주지 않음: 서버 DB가 되살아나 세대가 오르내려도 철회 전 글은 남지 않고 철회 뒤 글은 지워지지 않게). 서버에는 지운 순번을 순번과 세대만 보낸다.
 * 쓰기(수음 서비스, 메인 스레드)와 보내기(통신 스레드)가 갈라져 있어 목록은 잠금 안에서만 만진다. 보내는 동안은 잠그지 않는다.
 */
class Outbox(dir: File, val trip: String, private val seal: Seal) {
    private val file = File(dir, "utterances-$trip.jsonl")
    private val stateFile = File(dir, "utterances-$trip.acked")
    private val items = mutableListOf<Utterance>()
    var acked = 0L
        private set
    private var createdAt = 0L
    private var wiped = 0L // 동의 철회로 글을 지운 마지막 순번

    /** 지금 동의 세대. 새 발화에 붙인다. 화면이 서버 여행을 받을 때마다 see()로 맞춘다. */
    @Volatile var generation = 1
        private set
    private var before = 1 // 바로 앞 세대
    private var bumpedAt = 0L // 세대가 오른 것을 안 시각
    private var dirty = false // 메모리에서는 지웠는데 파일을 아직 바꾸지 못함(공간 부족 등). 조회마다 다시 한다
    private var sent = 0L // 이번 실행에서 보낸 마지막 순번. 보낼 수 없는 지운 발화 뒤로 나아가는 데만 쓴다

    init {
        if (file.exists()) {
            file.forEachLine { line -> runCatching { Utterance.parse(seal.unline(line)) }.getOrNull()?.let { items += it } }
            if (file.length() > 0 && !file.readText().endsWith("\n")) file.appendText("\n") // 끊긴 줄 뒤에 붙여 쓰지 않게
        }
        state(stateFile, seal)?.let { acked = it.optLong("acked"); createdAt = it.optLong("createdAt"); wiped = it.optLong("wiped") }
        generation = items.maxOfOrNull { it.generation } ?: 1 // 새 발화에 붙일 값. 서버 여행을 받으면 see()가 맞춘다
        blank { it.seq <= wiped } // 지난번에 지우다 파일을 바꾸지 못했으면 여기서 다시
    }

    private val said get() = items.filter { it.text.isNotEmpty() }
    val size: Int @Synchronized get() = said.size
    val pending: Int @Synchronized get() = items.count { it.seq > acked }

    @Synchronized fun recent(n: Int): List<Utterance> = said.takeLast(n)

    /** 지금 동의 세대의 글 있는 발화(시각 순). 차 안 판단(할 일 도출 T144)의 입력 — 철회로 지운 글과 옛 세대는 들어가지 않는다. */
    @Synchronized fun lines(): List<Utterance> = said.filter { it.generation == generation }

    /** 그 순번들의 발화를 화자와 함께 다시 올릴 모양으로(서버가 화자가 빈 줄에만 채운다, ADR-0023). 글을 지웠거나 옛 세대면 뺀다. */
    @Synchronized fun wires(who: Map<Long, Speaker>): List<Pair<Long, JSONObject>> =
        items.filter { it.seq in who && it.seq <= acked }.mapNotNull { u -> u.wire(generation)?.takeIf { it.has("text") }?.let { u.seq to it.spokenBy(who.getValue(u.seq)) } }

    /** 서버가 받은 순번 (after, acked]의 글이 있는 발화. 화자 대조(T37)에 쓴다. */
    @Synchronized fun ackedAfter(after: Long): List<Utterance> = items.filter { it.seq in (after + 1)..acked && it.text.isNotEmpty() }

    /**
     * 위치는 발화 끝에서 FIX_MS 안에 받은 것만 붙인다. zone은 좌석 구역(T37). 세대가 오른 것을 알기 전에 시작한 말(동의 철회 사이에 한 말일 수 있음)은
     * 앞 세대로, 글 없이 남긴다(폰에서 끄고 10초 조회 안에 다시 켜 기록이 이어진 경우).
     */
    @Synchronized fun add(d: Draft, fix: Fix?, zone: Int? = null): Utterance {
        val old = d.startedAt < bumpedAt
        val f = fix?.takeIf { !old && kotlin.math.abs(d.endedAt - it.at) <= FIX_MS }
        val u = Utterance((items.lastOrNull()?.seq ?: 0) + 1, trip, d.startedAt, d.endedAt, if (old) "" else d.text, d.audioFromMs, d.audioToMs,
            if (old) before else generation, f?.lat, f?.lng, zone)
        file.appendText(seal.line(u.json().toString()) + "\n")
        items += u
        return u
    }

    /**
     * 서버 여행의 동의 세대와 만든 시각. 만든 시각은 상태 파일에 적어 재접속 후에도 여행 정보를 유지한다.
     * 세대가 올라갔으면(동의 철회) 그때까지의 순번을 지우고 경계를 남긴다. 지운 것이 있으면 true.
     */
    @Synchronized fun see(g: Int, born: Long): Boolean {
        if (dirty) dirty = !rewrite() // 지난번에 바꾸지 못한 파일(철회한 글이 남아 있음)
        if (born != createdAt && born > 0) { createdAt = born; saveState() }
        if (g < generation) generation = g // 서버 DB를 백업에서 되살림: 서버의 세대를 따른다(넘는 세대로 보내면 400)
        if (g <= generation) return false
        before = generation; generation = g; bumpedAt = System.currentTimeMillis()
        val last = items.lastOrNull()?.seq ?: 0
        if (last > wiped) { wiped = last; saveState() }
        return blank { it.seq <= wiped }
    }

    /**
     * 참가자가 서버에서 자기 글을 지운 것(DELETE /utterances는 줄을 남기고 글만 비움)을 차 사본에도 옮긴다.
     * kept는 서버에 글이 남아 있는 이 기기의 순번(GET /utterances?device=). 서버가 받았다고 한 데까지(acked) 가운데 kept에 없는 발화는 글을 지운다.
     * acked는 같은 차례에 서버에서 받은 값이어야 한다(되살린 DB에서 잃은 순번을 지운 것으로 보지 않게). 지운 것이 있으면 true.
     */
    @Synchronized fun prune(kept: Set<Long>): Boolean = blank { it.seq <= acked && it.seq !in kept }

    /** 고른 발화의 글과 위치를 지우고 파일을 바꾼다. 바꾸지 못하면 표시를 남겨 다음 see()에서 다시. 지운 것이 있으면 true. */
    private fun blank(which: (Utterance) -> Boolean): Boolean {
        if (items.none { which(it) && it.text.isNotEmpty() }) return false
        for (i in items.indices) if (which(items[i])) items[i] = items[i].copy(text = "", lat = null, lng = null)
        dirty = !rewrite()
        return true
    }

    /** 임시 파일에 다 쓴 뒤 이름을 바꾼다. 둘 중 하나라도 실패하면 false(앞의 파일이 남음). */
    private fun rewrite(): Boolean = runCatching {
        val tmp = File(file.path + ".tmp")
        tmp.writeText(items.joinToString("") { seal.line(it.json().toString()) + "\n" })
        tmp.renameTo(file)
    }.getOrDefault(false)

    /** 임시 파일에 다 쓴 뒤 이름을 바꿔 확인 순번과 철회 경계를 보존한다. */
    private fun saveState() {
        val tmp = File(stateFile.path + ".tmp")
        tmp.writeText(seal.line(JSONObject().put("acked", acked).put("createdAt", createdAt).put("wiped", wiped).toString()))
        tmp.renameTo(stateFile)
    }

    /**
     * 받지 않은 것을 max건까지 보낸다. 통신 스레드에서 부른다. 보낸 뒤 서버가 받았다고 한 데까지로 acked를 맞춘다.
     * always면 보낼 것이 없어도 빈 묶음으로 서버의 lastSeq를 받는다(서버 DB가 되살아나 순번이 내려갔으면 그 뒤부터 다시 보내게, ADR-0014 2절. prune 앞에서도).
     */
    fun flush(up: Uplink, device: String, max: Int = 100, always: Boolean = false) {
        val batch = synchronized(this) {
            // 서버가 세대 1로 되살아나 지운 발화를 보낼 수 없으면 lastSeq가 그 앞에서 멈춘다. 그때는 이번 실행에서 보낸 데 뒤부터 보내
            // 지운 발화가 묶음 크기보다 많아도 새 발화가 나가게 한다. 보통은 받은 데(acked) 뒤부터 다시 보낸다(ADR-0014).
            val first = items.firstOrNull { it.seq > acked }
            val from = if (first != null && first.wire(generation) == null) maxOf(acked, sent) else acked
            items.asSequence().filter { it.seq > from }.mapNotNull { u -> u.wire(generation)?.let { u.seq to it } }.take(max).toList()
        }
        if (batch.isEmpty() && !always) return
        val got = up.send(device, JSONArray(batch.map { it.second }))
        synchronized(this) {
            sent = if (got < acked) got else maxOf(sent, batch.lastOrNull()?.first ?: 0) // 서버 순번이 내려가면 그 뒤부터 다시
            if (got != acked) { acked = got; saveState() }
        }
    }

    companion object {
        private fun state(f: File, seal: Seal): JSONObject? = runCatching { JSONObject(seal.unline(f.readText())) }.getOrNull()

        /** 보관함에 적어 둔 여행의 만든 시각. 없거나 열리지 않으면 null. */
        fun createdAtOf(dir: File, trip: String, seal: Seal): Long? =
            state(File(dir, "utterances-$trip.acked"), seal)?.optLong("createdAt")?.takeIf { it > 0 }
    }
}

// ---- 말한 사람(T37): 좌석 구역 + 차 안의 목소리 대조(Voice.kt, ADR-0023) ----

/** 발화 한 건의 말한 사람: 참가자 id(모르면 null), 대조 확신도, 사람이 화면에서 고쳤는지, 서버에 남겼는지(차가 찾은 사람과 사람이 고친 것 모두). */
data class Speaker(val who: String?, val confidence: Double, val byPerson: Boolean = false, val sent: Boolean = true)

/**
 * 발화 순번별 말한 사람. speakers-<여행>.jsonl에 한 줄씩 덧붙이고(암호화, 뒤의 줄이 앞을 덮음) 앱을 다시 켜면 이어 읽는다.
 * 보관함을 다시 쓰지 않으려고 따로 둔다(발화마다 보관함 전체를 다시 쓰지 않게). 메인 스레드와 통신 스레드가 같이 쓴다.
 * through는 대조를 마친(또는 버린) 마지막 순번: 실패하거나 앱이 꺼져도 그 뒤부터 다시 대조한다.
 * 동의 세대가 오르면(동의 철회) 옛 발화의 말한 사람을 지운다(서버도 목소리 등록값을 지움).
 */
class Speakers(dir: File, val trip: String, private val seal: Seal) {
    private val file = File(dir, "speakers-$trip.jsonl")
    private val map = HashMap<Long, Speaker>()
    var through = 0L
        private set
    private var gen = 0

    init {
        if (file.exists()) file.forEachLine { line ->
            runCatching { JSONObject(seal.unline(line)) }.getOrNull()?.let { o ->
                when {
                    o.has("through") -> through = o.getLong("through")
                    o.has("gen") -> gen = o.getInt("gen")
                    else -> map[o.getLong("seq")] = Speaker(o.optString("who").ifEmpty { null }, o.getDouble("confidence"), o.optBoolean("byPerson"), o.optBoolean("sent", true))
                }
            }
        }
    }

    @Synchronized operator fun get(seq: Long): Speaker? = map[seq]

    @Synchronized fun set(seq: Long, s: Speaker) {
        if (map[seq]?.byPerson == true && !s.byPerson) return // 사람이 고친 것은 대조가 덮지 않는다
        map[seq] = s
        put(JSONObject().put("seq", seq).put("who", s.who ?: "").put("confidence", s.confidence).put("byPerson", s.byPerson).put("sent", s.sent))
    }

    /** 차가 찾았지만 아직 서버에 남기지 못한 것. 발화와 함께 다시 올린다. */
    @Synchronized fun unsentMatches(): Map<Long, Speaker> = map.filter { !it.value.byPerson && !it.value.sent && it.value.who != null }

    /** 사람이 고쳤지만 아직 서버에 남기지 못한 것(끊김 등). 다음 차례에 다시 보낸다. */
    @Synchronized fun unsent(): List<Pair<Long, Speaker>> = map.filter { it.value.byPerson && !it.value.sent }.map { it.key to it.value }

    @Synchronized fun done(seq: Long) { if (seq > through) { through = seq; put(JSONObject().put("through", seq)) } }

    /** 동의 세대. 올랐으면 지금까지의 말한 사람을 모두 지운다(그 발화는 모두 옛 세대). 처음 본 세대면 적기만 한다. */
    @Synchronized fun see(g: Int) {
        if (g <= gen) return
        if (gen > 0) { map.clear(); file.delete() } // through는 그대로: 옛 발화를 다시 대조하지 않게
        gen = g
        put(JSONObject().put("gen", g)); if (through > 0) put(JSONObject().put("through", through))
    }

    private fun put(o: JSONObject) = file.appendText(seal.line(o.toString()) + "\n")
}
