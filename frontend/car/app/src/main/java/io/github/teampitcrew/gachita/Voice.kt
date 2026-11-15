package io.github.teampitcrew.gachita

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.log2
import kotlin.math.sin
import kotlin.math.sqrt

// 누가 말했는지 차 안에서 가린다(ADR-0023). 발화 소리와 등록 음성은 차를 떠나지 않고, 서버는 대조 값의 저장·조회만 맡는다.
// 임베더는 backend/api/providers/voice.js와 같은 수식·같은 상수다. 두 구현은 backend/api/voice-vectors.json으로 묶는다(VoiceTest.kt) —
// 한쪽만 고치면 등록(다른 기기)과 대조(이 차)의 값이 어긋나 조용히 '모름'이 늘어난다. 수식을 고치면 이름을 함께 올린다.

const val EMBEDDER = "logmel-pitch-1"
private const val MEL_BANDS = 26
private const val FRAME = 512 // 32 ms @ 16 kHz
private const val HOP = 160 // 10 ms
private const val PITCH_BINS = 20
private const val SILENT_FRAME = 1e-10 // 프레임의 평균 제곱이 이보다 작으면 무음(약 −100 dBFS)
const val VOICE_DIMS = MEL_BANDS * 2 + PITCH_BINS * 3

/** 16비트 LE 모노 PCM → 표본(−1~1). 서버의 wavMono와 같은 값(32768로 나눔). */
fun pcmSamples(pcm: ByteArray): FloatArray =
    FloatArray(pcm.size / 2) { i -> ((pcm[2 * i].toInt() and 0xFF) or (pcm[2 * i + 1].toInt() shl 8)) / 32768f }

/** 자리 교체 없는 반복 radix-2 FFT(길이는 2의 거듭제곱). */
private fun fft(re: DoubleArray, im: DoubleArray) {
    val n = re.size
    var j = 0
    for (i in 1 until n) {
        var bit = n shr 1
        while (j and bit != 0) { j = j xor bit; bit = bit shr 1 }
        j = j xor bit
        if (i < j) {
            val r = re[i]; re[i] = re[j]; re[j] = r
            val m = im[i]; im[i] = im[j]; im[j] = m
        }
    }
    var len = 2
    while (len <= n) {
        val ang = (-2 * PI) / len
        var i = 0
        while (i < n) {
            for (k in 0 until len / 2) {
                val wr = cos(ang * k); val wi = sin(ang * k)
                val ur = re[i + k]; val ui = im[i + k]
                val vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi
                val vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr
                re[i + k] = ur + vr; im[i + k] = ui + vi
                re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi
            }
            i += len
        }
        len = len shl 1
    }
}

private val WINDOW = DoubleArray(FRAME) { 0.54 - 0.46 * cos((2 * PI * it) / (FRAME - 1)) }
private val MEL_BINS = run {
    fun mel(hz: Double) = 2595 * ln(1 + hz / 700)
    val low = mel(50.0); val high = mel(7600.0)
    IntArray(MEL_BANDS + 2) { i -> Math.round((700 * (exp((low + ((high - low) * i) / (MEL_BANDS + 1)) / 2595) - 1) / 16000) * FRAME).toInt() }
}

/** 묶음의 평균을 빼고 단위 길이로(길이가 0이면 그대로 0). */
private fun group(a: DoubleArray): DoubleArray {
    val m = a.sum() / a.size
    var n = 0.0
    for (v in a) n += (v - m) * (v - m)
    n = sqrt(n).takeIf { it != 0.0 } ?: 1.0
    return DoubleArray(a.size) { (a[it] - m) / n }
}

/**
 * 표본(16 kHz 모노)을 대조용 벡터로: 로그멜 평균·분산 + 음높이 히스토그램(무게 3배), 묶음마다 평균 0·길이 1.
 * 한 프레임(32 ms)보다 짧으면 null. 더하는 순서까지 voice.js와 같게 둔다(값이 같아야 한다).
 */
fun embed(samples: FloatArray): DoubleArray? {
    val frames = ArrayList<DoubleArray>()
    val re = DoubleArray(FRAME); val im = DoubleArray(FRAME)
    var off = 0
    while (off + FRAME <= samples.size) {
        var mean = 0.0
        for (i in 0 until FRAME) mean += samples[off + i]
        mean /= FRAME
        // 완전한 무음 프레임(디지털 0 — 에뮬레이터에 넣는 소리의 앞뒤, 등록 때 원음 자리에 채운 무음)은 건너뛴다(서버 voice.js와 같은 규칙).
        // 넣으면 로그멜이 바닥값으로 찍혀 평균·분산이 크게 틀어진다. 실제 마이크 소리에는 이런 프레임이 없어 값이 바뀌지 않는다.
        var energy = 0.0
        for (i in 0 until FRAME) { val d = samples[off + i] - mean; energy += d * d }
        if (energy / FRAME < SILENT_FRAME) { off += HOP; continue }
        for (i in 0 until FRAME) { re[i] = (samples[off + i] - mean) * WINDOW[i]; im[i] = 0.0 }
        fft(re, im)
        val mel = DoubleArray(MEL_BANDS)
        for (b in 0 until MEL_BANDS) {
            val lo = MEL_BINS[b]; val mid = MEL_BINS[b + 1]; val hi = MEL_BINS[b + 2]
            var e = 0.0
            for (i in maxOf(1, lo)..minOf(FRAME / 2 - 1, hi)) {
                val up = (i - lo).toDouble() / (if (mid - lo != 0) mid - lo else 1)
                val down = (hi - i).toDouble() / (if (hi - mid != 0) hi - mid else 1)
                e += (re[i] * re[i] + im[i] * im[i]) / FRAME * maxOf(0.0, minOf(up, down))
            }
            mel[b] = log10(e + 1e-10)
        }
        frames += mel
        off += HOP
    }
    if (frames.isEmpty()) return null
    val mean = DoubleArray(MEL_BANDS)
    for (f in frames) for (i in 0 until MEL_BANDS) mean[i] += f[i]
    for (i in 0 until MEL_BANDS) mean[i] /= frames.size
    val std = DoubleArray(MEL_BANDS)
    for (f in frames) for (i in 0 until MEL_BANDS) std[i] += (f[i] - mean[i]) * (f[i] - mean[i])
    for (i in 0 until MEL_BANDS) std[i] = sqrt(std[i] / frames.size)

    // 음높이: 4배 간추린 신호의 자기상관(60~400 Hz)에서 유성 프레임의 주파수를 모은다.
    val decim = DoubleArray(samples.size / 4) { i -> (samples[4 * i].toDouble() + samples[4 * i + 1] + samples[4 * i + 2] + samples[4 * i + 3]) / 4 }
    val lagMin = 4000 / 400; val lagMax = 4000 / 60
    val pitch = DoubleArray(PITCH_BINS)
    var voicedFrames = 0
    var at = 0
    while (at + lagMax * 2 <= decim.size) {
        var e0 = 0.0
        for (i in 0 until lagMax) e0 += decim[at + i] * decim[at + i]
        if (e0 >= 1e-6) {
            var bestLag = 0; var bestR = 0.0
            for (lag in lagMin..lagMax) {
                var r = 0.0
                for (i in 0 until lagMax) r += decim[at + i] * decim[at + i + lag]
                val norm = r / e0
                if (norm > bestR) { bestR = norm; bestLag = lag }
            }
            if (bestR > 0.35 && bestLag != 0) {
                // 60~500 Hz 로그 눈금 20구간
                val bin = floor((log2(4000.0 / bestLag / 60) / log2(500.0 / 60)) * PITCH_BINS).toInt().coerceIn(0, PITCH_BINS - 1)
                pitch[bin]++; voicedFrames++
            }
        }
        at += lagMax
    }
    val total = if (voicedFrames != 0) voicedFrames else 1
    for (i in 0 until PITCH_BINS) pitch[i] /= total
    return group(mean) + group(std) + group(pitch + pitch + pitch)
}

/** 코사인 유사도. */
fun similarity(a: DoubleArray, b: DoubleArray): Double {
    var dot = 0.0; var na = 0.0; var nb = 0.0
    for (i in 0 until minOf(a.size, b.size)) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
    return dot / (sqrt(na) * sqrt(nb)).let { if (it != 0.0) it else 1.0 }
}

/**
 * 이 여행 탑승자의 대조 값 사본(GET /voice-prints). 민감정보라 다른 차 안 파일처럼 암호화해 둔다(Vault.kt) — voiceprints-<여행>.json.
 * 주행(기록)을 시작할 때 받아 PRINTS_KEEP_MS(3시간 30분) 동안 쓰고, 그 뒤에는 지우고 다시 받는다 — 발화마다 서버에 묻지 않는다.
 * 받을 때마다 서버 응답으로 통째로 바꾼다(서버에서 사라진 값이 차에 남지 않게). 동의 세대가 바뀌면(누군가 철회) 지우고 다시 받는다.
 * 여행이 지워지면 dropTrip이 다른 파일과 함께 지운다. 기준값(threshold)은 서버가 준 것만 쓴다(차에 따로 적어 두지 않음).
 * 화면(세대 확인)과 통신 스레드(받기·대조)가 같이 쓴다.
 */
const val PRINTS_KEEP_MS = 210 * 60_000L

class VoicePrints(dir: File, val trip: String, private val seal: Seal, now: Long = System.currentTimeMillis()) {
    private val file = File(dir, "voiceprints-$trip.json")
    private var generation = 0
    private var threshold = 2.0 // 받은 값이 없으면 아무도 맞지 않는다
    private var floor = Double.NaN // 여백 규칙의 바닥과 여백(서버가 줄 때만, identify)
    private var margin = Double.NaN
    private var always = true // 미확인 0%: 여백 규칙을 넘지 못해도 가장 가까운 사람으로 정한다(서버가 assign: "margin"을 주면 끔)
    private var prints = emptyMap<String, DoubleArray>()
    private var strong = emptyMap<String, FloatArray>() // 둘째 값(강한 화자 값, StrongVoice.kt). 서버가 맡아 둔 것을 함께 받는다
    /** 사본을 받은 시각(파일에 함께 둔다). 0이면 다음 대조 전에 다시 받는다(등록함, 탑승자가 바뀜). */
    @Volatile var fetchedAt = 0L
    // init보다 앞에 둔다: 뒤에 두면 init의 read()가 되살린 값을 속성 초기화가 다시 0으로 덮어, 다시 켠 뒤 첫 expire()가 유효한 사본을 지운다.
    private var savedAt = 0L // 파일에 적힌 받은 시각(다시 받으라는 표시 fetchedAt = 0과 따로)

    init { runCatching { read(JSONObject(seal.unline(file.readText()))) }; expire(now) } // 없거나 열리지 않으면 빈 사본

    /** 다시 받아야 하는지: 받은 적이 없거나, 다시 받으라고 표시했거나, 보관 시간이 지남. */
    fun stale(now: Long) = fetchedAt <= 0 || now - fetchedAt >= PRINTS_KEEP_MS

    /** 보관 시간이 지난 사본은 지운다(끊겨서 다시 받지 못해도 오래된 값으로 대조하지 않게). */
    @Synchronized fun expire(now: Long) { if (generation != 0 && now - savedAt >= PRINTS_KEEP_MS) clear() }

    val size: Int @Synchronized get() = prints.size
    /** 대조 값이 있는(어디서든 등록한) 참가자 id. */
    @Synchronized fun ids(): Set<String> = prints.keys.toSet()

    private fun read(o: JSONObject) {
        // 다른 임베더의 값과는 견주지 않는다(서버가 수식을 바꿨는데 이 앱이 옛것이면 붙이지 않고 '모름')
        val ok = o.optString("embedder") == EMBEDDER && o.optInt("dims") == VOICE_DIMS
        val items = o.getJSONArray("items")
        prints = if (!ok) emptyMap() else (0 until items.length()).map { items.getJSONObject(it) }.associate { p ->
            p.getString("participantId") to p.getJSONArray("vector").let { v -> DoubleArray(v.length()) { i -> v.getDouble(i) } }
        }.filterValues { it.size == VOICE_DIMS }
        // 둘째 값: 이름이 이 앱의 모델과 같을 때만(모델이 바뀌면 견주지 않고 1차 규칙으로). 1차 값이 있는 사람의 것만 둔다
        strong = if (o.optString("strongEmbedder") != STRONG_EMBEDDER) emptyMap() else (0 until items.length()).map { items.getJSONObject(it) }
            .filter { it.optJSONArray("strong")?.length() == STRONG_DIMS && it.getString("participantId") in prints }
            .associate { p -> p.getString("participantId") to p.getJSONArray("strong").let { v -> FloatArray(v.length()) { i -> v.getDouble(i).toFloat() } } }
        generation = o.getInt("generation"); threshold = o.getDouble("threshold")
        floor = o.optDouble("floor"); margin = o.optDouble("margin") // 옛 서버는 주지 않는다(NaN)
        always = o.optString("assign") != "margin"
        savedAt = o.optLong("fetchedAt"); fetchedAt = savedAt
    }

    private var dropped = false
    // 여행 조회로 마지막에 확인한 동의 세대. 사본을 지워도 남긴다: 조회 응답을 기다리는 사이 누군가 폰에서 철회하면(세대가 오름)
    // 철회 전 세대의 응답이 뒤늦게 와도 저장하지 않게.
    private var seen = 0

    /**
     * 사본을 버리고 이 인스턴스를 닫는다: 이 차에서 동의를 철회했을 때(서버에 아직 전하지 못했어도 바로), 여행을 떠나거나 여행이 지워졌을 때.
     * 값과 파일을 지우고, 그 뒤에 도착하는 조회 응답(앞서 시작한 요청)은 저장하지 않는다 — 지운 민감정보가 늦은 응답으로 되살아나지 않게.
     * 버린 뒤에는 되돌리지 않는다. 다시 쓰려면 새 인스턴스를 만든다(다시 동의한 뒤 새로 받음).
     */
    @Synchronized fun drop() { dropped = true; clear() }

    /** 서버 응답으로 바꾼다. 임시 파일에 쓴 뒤 이름을 바꾼다. 버린 인스턴스면 아무것도 저장하지 않는다(false) — 확인과 저장이 한 잠금 안. */
    @Synchronized fun put(o: JSONObject, now: Long = System.currentTimeMillis()): Boolean {
        if (dropped || o.optInt("generation") < seen) return false // 버린 인스턴스, 또는 조회를 시작한 뒤 철회가 있었음(옛 세대의 응답)
        read(o.put("fetchedAt", now))
        val tmp = File(file.path + ".tmp")
        tmp.writeText(seal.line(o.toString())); tmp.renameTo(file)
        return true
    }

    /**
     * 대조 전에 부른다(통신 스레드): 보관 시간이 지난 사본은 지우고, 다시 받아야 하면 fetch로 받아 바꾼다.
     * 서버에 닿지 않으면(IOException) 보관 시간 안의 사본으로 계속한다 — 사본이 없을 때만 던져 이번 대조를 미룬다.
     * 서버가 거절하면(동의 대기 403, 옛 서버 404) 그대로 던진다. 새로 받았으면 true.
     */
    fun refresh(now: Long, generation: Int, fetch: () -> JSONObject): Boolean {
        expire(now)
        if (!stale(now)) return false
        try {
            if (!put(fetch(), now)) return false // 받는 사이 버려짐(이 차나 폰에서 철회, 여행 삭제)
            see(generation)
            return true
        } catch (e: java.io.IOException) {
            if (size == 0) throw e
            return false
        }
    }

    /** 지금 동의 세대. 사본의 세대와 다르면 지운다(철회 전의 값으로 대조하지 않게). */
    @Synchronized fun see(g: Int) {
        seen = g
        if (generation == 0 || generation == g) return // 받은 것이 없거나 같은 세대
        clear()
    }

    private fun clear() {
        prints = emptyMap(); strong = emptyMap(); generation = 0; threshold = 2.0; floor = Double.NaN; margin = Double.NaN; fetchedAt = 0; savedAt = 0
        file.delete()
    }

    /** 후보(참가자 id) 가운데 가장 비슷한 사람. 기준에 못 미치면 who = null('모름'). 서버의 voiceMatch와 같은 규칙. */
    @Synchronized fun match(v: DoubleArray, candidates: Collection<String>): Speaker {
        var best: String? = null; var bestSim = -1.0
        for (id in candidates) { val s = similarity(v, prints[id] ?: continue); if (s > bestSim) { bestSim = s; best = id } }
        if (best == null) return Speaker(null, 0.0)
        return Speaker(best.takeIf { bestSim >= threshold }, Math.round(bestSim * 1000) / 1000.0)
    }

    /**
     * 발화 한 건의 말한 사람을 정한다. all은 녹음에 동의한 탑승자, row는 발화의 좌석 줄에 앉은 사람(줄을 모르면 null).
     * 여백 규칙(서버가 floor·margin을 줄 때): 절대 기준 하나로는 실제 목소리가 잘 갈리지 않는다 — 유사도가 전체로 낮은 소리는 누구와도
     * 기준을 못 넘고, 높은 소리는 두 사람이 함께 넘어 틀린다. 그래서 후보 전체에서 가장 비슷한 사람이 바닥 이상이고 **두 번째 사람보다
     * 여백 이상 앞설 때만** 붙인다. 그 사람이 발화의 줄과 다른 줄에 앉았으면 붙이지 않는다(줄로 먼저 좁히면 다른 줄의 비슷한 사람을
     * 못 봐서 틀림이 늘었다). 후보가 한 명뿐이면 견줄 사람이 없으니 절대 기준을 쓴다.
     * 실제 차 안 목소리 조각 118개(11/15): 절대 기준 0.85 → 맞힘 55·틀림 14·모름 49, 이 규칙(0.6·0.06) → 69·12·37.
     * 옛 서버(값을 주지 않음)에서는 전처럼 줄에서 먼저 찾고 없으면 모두에서 절대 기준으로 찾는다.
     */
    @Synchronized fun identify(v: DoubleArray, all: Collection<String>, row: Collection<String>?): Speaker {
        if (floor.isNaN() || margin.isNaN()) return row?.let { match(v, it) }?.takeIf { it.who != null } ?: match(v, all)
        val sims = all.mapNotNull { id -> prints[id]?.let { id to similarity(v, it) } }.sortedByDescending { it.second }
        val (best, sim) = sims.firstOrNull() ?: return Speaker(null, 0.0)
        val sure = if (sims.size == 1) sim >= threshold else sim >= floor && sim - sims[1].second >= margin
        if (sure && (row == null || best in row)) return Speaker(best, Math.round(sim * 1000) / 1000.0, basis = "margin")
        if (!always) return Speaker(null, Math.round(sim * 1000) / 1000.0)
        // 미확인 0%(오너 11/15): 등록한 사람이 있으면 늘 누군가로 정한다. 줄을 알면 그 줄에서, 모르거나 그 줄에 등록한 사람이 없으면 모두에서 가장 가까운 사람.
        // 실제 차 안 목소리에서 이렇게 정한 이름의 3~4할은 틀린다(교정본 36줄 가운데 22줄 맞음) — 사람이 고칠 수 있고, 근거(basis)를 남긴다.
        val (pick, near) = row?.let { r -> sims.firstOrNull { it.first in r } } ?: sims.first()
        return Speaker(pick, Math.round(near * 1000) / 1000.0, basis = "nearest")
    }

    /** 둘째 값을 가진 사람이 있는지(없으면 강한 모델을 올리지 않는다). */
    val hasStrong: Boolean @Synchronized get() = strong.isNotEmpty()

    /**
     * 둘째 값(강한 화자 값)으로 말한 사람을 정한다. all은 녹음에 동의한 탑승자, row는 발화의 좌석 줄에 앉은 사람(줄을 모르면 null).
     * 등록한 탑승자 **모두**가 둘째 값을 가졌을 때만 정한다 — 한 명이라도 없으면(옛 앱에서 등록, 모델을 못 올린 기기) 견줄 수 없으니 null을 돌려주고
     * 부르는 쪽이 1차 임베더(identify)로 정한다. 규칙: 그 줄에 앉은 등록자 가운데 가장 가까운 사람, 줄을 모르거나 그 줄에 등록자가 없으면
     * 등록자 모두 가운데 가장 가까운 사람(미확인 0%). 시연 원천의 교정본 36줄에서 27줄 맞음(맥에서 같은 모델, 1차 임베더는 22줄).
     */
    @Synchronized fun identifyStrong(v: FloatArray, all: Collection<String>, row: Collection<String>?): Speaker? {
        val who = all.filter { it in prints }
        if (who.isEmpty() || who.any { it !in strong }) return null
        val sims = who.map { it to cosine(v, strong.getValue(it)) }.sortedByDescending { it.second }
        val (best, sim) = row?.let { r -> sims.firstOrNull { it.first in r } } ?: sims.first()
        return Speaker(best, Math.round(sim * 1000) / 1000.0, basis = "strong")
    }

    /** 미확인 0% 규칙이 켜져 있고 견줄 등록값이 있는지. 켜져 있으면 값을 못 낸 짧은 말도 앞뒤 말의 사람을 물려받는다(inherit). */
    val assignsAlways: Boolean @Synchronized get() = always && !floor.isNaN() && !margin.isNaN() && prints.isNotEmpty()
}

/**
 * 값을 못 낸 발화(0.6초보다 짧음, 원음이 없음)의 말한 사람을 앞뒤 말에서 물려받는다: 같은 좌석 줄에서 시각이 가장 가까운 말의 사람,
 * 그 줄에 아는 말이 없으면 줄과 무관하게 가장 가까운 말의 사람. known은 사람이 정해진 발화들. 아무것도 없으면 null.
 */
fun inherit(u: Utterance, known: List<Pair<Utterance, String>>): String? =
    (known.filter { u.seatZone != null && it.first.seatZone == u.seatZone }.ifEmpty { known })
        .minByOrNull { kotlin.math.abs(it.first.startedAt - u.startedAt) }?.second

const val CONSENT_FRESH_MS = 5 * 60_000L // 끊긴 동안에는 마지막으로 동의를 확인한 뒤 이 시간까지만 차 안 대조를 잇는다(ADR-0007의 5분)

/**
 * 말한 사람 한 차례(통신 스레드). 차 안 대조(match)는 통신이 필요 없으니 먼저 하고, 서버에 보내는 일(사람이 고친 것 fixes,
 * 찾은 화자 send)이 실패해도 대조를 막지 않는다 — 보내지 못한 것은 재전송 대기로 남아 다음 차례에 간다.
 * 셋을 모두 해 보고 첫 실패를 돌려준다(없으면 null).
 */
fun speakerRound(match: () -> Unit, fixes: () -> Unit, send: () -> Unit): Throwable? =
    listOf(match, fixes, send).mapNotNull { runCatching(it).exceptionOrNull() }.firstOrNull()

const val SPEAKER_BATCH = 100 // 화자를 다시 올리는 한 묶음. 서버는 한 번에 500건까지 받는다

/**
 * 차가 찾았지만 서버에 남기지 못한 화자를 그 발화와 함께 다시 올린다(통신 스레드). 서버 한도 아래의 묶음으로 나눠 보내고,
 * **성공한 묶음의 순번만** 남긴 것으로 적는다 — 오래 끊겨 수백 건이 쌓여도 한 요청이 한도를 넘어 영영 거절되지 않게.
 * 묶음 하나가 실패하면 던지고, 남은 것은 다음 차례에 이어 보낸다. 글을 지웠거나 옛 세대라 보낼 수 없는 것은 더 보내지 않는다.
 * allowed는 묶음마다 다시 본다(모두 동의, 끄기 대기 없음).
 */
fun sendSpeakers(box: Outbox, sp: Speakers, allowed: () -> Boolean, send: (JSONArray) -> Unit) {
    val found = sp.unsentMatches()
    val items = box.wires(found)
    val sendable = items.map { it.first }.toSet()
    fun done(seqs: Iterable<Long>) = seqs.forEach { seq -> found[seq]?.let { sp.set(seq, it.copy(sent = true)) } }
    done(found.keys.filter { it <= box.acked && it !in sendable })
    for (batch in items.sortedBy { it.first }.chunked(SPEAKER_BATCH)) {
        if (!allowed()) return
        send(JSONArray(batch.map { it.second }))
        done(batch.map { it.first })
    }
}

/** 값으로 하는 목소리 등록의 본문(POST …/voice, application/json). */
fun voiceValue(vector: DoubleArray, seconds: Double): JSONObject =
    JSONObject().put("embedder", EMBEDDER).put("vector", JSONArray().apply { vector.forEach { put(it) } }).put("seconds", seconds)

/** 차가 붙인 화자를 발화 항목에 더한다(POST /utterances의 선택 칸). */
fun JSONObject.spokenBy(s: Speaker): JSONObject =
    put("participantId", s.who).put("speakerMethod", "device-voice").put("speakerConfidence", s.confidence.coerceIn(0.0, 1.0))
