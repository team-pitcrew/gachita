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
    private var prints = emptyMap<String, DoubleArray>()
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

    private fun read(o: JSONObject) {
        // 다른 임베더의 값과는 견주지 않는다(서버가 수식을 바꿨는데 이 앱이 옛것이면 붙이지 않고 '모름')
        val ok = o.optString("embedder") == EMBEDDER && o.optInt("dims") == VOICE_DIMS
        val items = o.getJSONArray("items")
        prints = if (!ok) emptyMap() else (0 until items.length()).map { items.getJSONObject(it) }.associate { p ->
            p.getString("participantId") to p.getJSONArray("vector").let { v -> DoubleArray(v.length()) { i -> v.getDouble(i) } }
        }.filterValues { it.size == VOICE_DIMS }
        generation = o.getInt("generation"); threshold = o.getDouble("threshold")
        savedAt = o.optLong("fetchedAt"); fetchedAt = savedAt
    }

    /** 서버 응답으로 바꾼다. 임시 파일에 쓴 뒤 이름을 바꾼다. */
    @Synchronized fun put(o: JSONObject, now: Long = System.currentTimeMillis()) {
        read(o.put("fetchedAt", now))
        val tmp = File(file.path + ".tmp")
        tmp.writeText(seal.line(o.toString())); tmp.renameTo(file)
    }

    /** 지금 동의 세대. 사본의 세대와 다르면 지운다(철회 전의 값으로 대조하지 않게). */
    @Synchronized fun see(g: Int) {
        if (generation == 0 || generation == g) return // 받은 것이 없거나 같은 세대
        clear()
    }

    private fun clear() {
        prints = emptyMap(); generation = 0; threshold = 2.0; fetchedAt = 0; savedAt = 0
        file.delete()
    }

    /** 후보(참가자 id) 가운데 가장 비슷한 사람. 기준에 못 미치면 who = null('모름'). 서버의 voiceMatch와 같은 규칙. */
    @Synchronized fun match(v: DoubleArray, candidates: Collection<String>): Speaker {
        var best: String? = null; var bestSim = -1.0
        for (id in candidates) { val s = similarity(v, prints[id] ?: continue); if (s > bestSim) { bestSim = s; best = id } }
        if (best == null) return Speaker(null, 0.0)
        return Speaker(best.takeIf { bestSim >= threshold }, Math.round(bestSim * 1000) / 1000.0)
    }
}

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
