package io.github.teampitcrew.gachita

import android.content.Context
import android.util.Log
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractor
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractorConfig
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.math.sqrt

// 차 안에서만 쓰는 두 번째 목소리 값(오너 11/15: '차에 강한 모델 넣기'). 1차 임베더(Voice.kt, 로그멜·음높이 통계)는 실제 목소리에서
// 같은 성별의 어른을 잘 가르지 못한다(시연 원천의 교정본 36줄: 늘 누군가로 정하면 22줄 맞음). 학습된 화자 모델(wespeaker resnet34,
// VoxCeleb, 256차원)을 차 안에서 돌리면 같은 줄에서 27줄이 맞았다(맥에서 같은 모델로 잰 값).
// - 실행기: sherpa-onnx 2.0.1(Apache-2.0)과 그 안의 ONNX Runtime. 모델 가중치는 wespeaker(CC BY 4.0). 둘 다 저장소에 넣지 않고 빌드 때 받는다(app/build.gradle).
// - 서버 계약은 그대로다: 서버에 올리는 대조 값은 여전히 1차 임베더의 것(ADR-0023). 이 값은 차를 떠나지 않는다 —
//   서버에 둘 칸도, 다른 기기와 맞출 시험 벡터도 없다. 등록 음성도 지금처럼 차를 떠나지 않는다.
// - 그래서 이 차에서 등록한 사람만(계정 온보딩의 본인, 가족 추가의 아이) 이 값을 가진다. 후보 가운데 이 값이 없는 등록자(폰에서 등록)가 있으면 그 발화는 1차 임베더의 규칙으로 판정한다.
// - 라이브러리나 모델을 올리지 못하면(다른 ABI, 메모리 부족) 앱은 그대로 돌고 1차 임베더만 쓴다.

/** 표본(16 kHz 모노, −1~1)을 화자 값으로. 값을 못 내면 null. */
fun interface StrongEmbedder { fun embed(samples: FloatArray): FloatArray? }

/** 디지털 무음(값이 모두 0인 10 ms 묶음)을 뺀다 — 에뮬레이터에 넣는 소리의 앞뒤·사이, 등록 때 원음 자리에 채운 무음. */
fun withoutSilence(samples: FloatArray): FloatArray {
    val out = FloatArray(samples.size); var n = 0; var i = 0
    while (i < samples.size) {
        val end = minOf(i + 160, samples.size)
        var zero = true
        for (k in i until end) if (samples[k] != 0f) { zero = false; break }
        if (!zero) { samples.copyInto(out, n, i, end); n += end - i }
        i = end
    }
    return out.copyOf(n)
}

/** wespeaker(sherpa-onnx). 처음 쓸 때 한 번 올리고, 실패하면 다시 시도하지 않는다. 통신·대조 스레드에서 부른다. */
object Wespeaker : StrongEmbedder {
    private const val TAG = "GachitaVoice"
    const val MODEL = "wespeaker.onnx" // assets. app/build.gradle이 빌드 때 받는다
    private var extractor: SpeakerEmbeddingExtractor? = null
    private var tried = false

    /** 쓸 수 있으면 이 객체, 아니면 null. */
    @Synchronized fun of(ctx: Context): StrongEmbedder? {
        if (!tried) {
            tried = true
            val t0 = System.currentTimeMillis()
            extractor = try {
                SpeakerEmbeddingExtractor(ctx.applicationContext.assets, SpeakerEmbeddingExtractorConfig(MODEL, 2, false, "cpu"))
            } catch (t: Throwable) { // UnsatisfiedLinkError(맞는 ABI의 라이브러리 없음), 모델 없음 등
                Log.w(TAG, "강한 화자 모델을 올리지 못함 — 1차 임베더만 씀", t); null
            }
            if (extractor != null) Log.i(TAG, "강한 화자 모델 준비 ${System.currentTimeMillis() - t0}ms 차원 ${extractor?.dim()}")
        }
        return if (extractor != null) this else null
    }

    @Synchronized override fun embed(samples: FloatArray): FloatArray? {
        val e = extractor ?: return null
        val voice = withoutSilence(samples)
        if (voice.size < RATE / 2) return null // 0.5초보다 짧으면 값을 내지 않는다
        return try {
            val t0 = System.currentTimeMillis()
            val s = e.createStream()
            try {
                s.acceptWaveform(voice, RATE); s.inputFinished()
                if (!e.isReady(s)) return null
                e.compute(s).also { Log.i(TAG, "강한 화자 값 ${voice.size * 1000L / RATE}ms 소리 → ${System.currentTimeMillis() - t0}ms") }
            } finally { s.release() }
        } catch (t: Throwable) { Log.w(TAG, "강한 화자 값을 내지 못함", t); null }
    }
}

fun cosine(a: FloatArray, b: FloatArray): Double {
    var dot = 0.0; var na = 0.0; var nb = 0.0
    for (i in 0 until minOf(a.size, b.size)) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
    return dot / (sqrt(na) * sqrt(nb)).let { if (it != 0.0) it else 1.0 }
}

/**
 * 이 차에서 등록한 사람의 강한 화자 값. 등록이 프로필 단위라(계정 온보딩, 가족 추가) 프로필 id로 둔다 — voice-strong.json 하나에 암호화해 둔다(Vault.kt).
 * 목소리에서 뽑은 값이라 민감정보다: 서버에 올리지 않고, 같은 프로필을 다시 등록하면 바꾸고, 로그아웃하면 모두 지운다. 앱 데이터를 지우면 함께 사라진다.
 * ponytail: 서버에서 그 프로필의 목소리 등록을 지워도(다른 기기) 이 차의 값은 로그아웃 전까지 남는다. 다만 판정은 서버 대조 값이 있는
 * 탑승자(enrolled)만 후보로 보므로, 등록을 지운 사람에게 이름이 붙지는 않는다.
 */
class StrongPrints(dir: File, private val seal: Seal) {
    private val file = File(dir, "voice-strong.json")
    private val prints = HashMap<String, FloatArray>()

    init {
        runCatching {
            val p = JSONObject(seal.unline(file.readText()))
            for (id in p.keys()) prints[id] = p.getJSONArray(id).let { a -> FloatArray(a.length()) { a.getDouble(it).toFloat() } }
        }
    }

    val size: Int @Synchronized get() = prints.size

    /** 등록: 그 프로필의 값을 넣고 파일을 바꾼다. */
    @Synchronized fun put(profileId: String, v: FloatArray) {
        prints[profileId] = v
        val o = JSONObject().apply { prints.forEach { (k, x) -> put(k, JSONArray().apply { x.forEach { put(it.toDouble()) } }) } }
        val tmp = File(file.path + ".tmp"); tmp.writeText(seal.line(o.toString())); tmp.renameTo(file)
    }

    /** 로그아웃: 모두 지운다. */
    @Synchronized fun clear() { prints.clear(); file.delete() }

    /**
     * 강한 값으로 말한 사람을 정한다. people은 녹음에 동의한 탑승자의 (참가자 id → 프로필 id, 손님이면 null), row는 발화의 좌석 줄에 앉은 참가자 id,
     * enrolled는 서버 대조 값이 있는(어디서든 등록한) 참가자 id다.
     * 등록한 탑승자 모두가 이 값을 가졌을 때만 정한다 — 한 명이라도 없으면(폰에서 등록) 견줄 수 없으니 null을 돌려주고, 부르는 쪽이 1차 임베더로 정한다.
     * 규칙: 그 줄에 앉은 등록자 가운데 가장 가까운 사람, 줄을 모르거나 그 줄에 등록자가 없으면 등록자 모두 가운데 가장 가까운 사람(미확인 0%).
     */
    @Synchronized fun identify(v: FloatArray, people: Map<String, String?>, row: Collection<String>?, enrolled: Collection<String>): Speaker? {
        val who = enrolled.filter { it in people }
        if (who.isEmpty() || who.any { people[it]?.let(prints::containsKey) != true }) return null
        val sims = who.map { id -> id to cosine(v, prints.getValue(people.getValue(id)!!)) }.sortedByDescending { it.second }
        val (best, sim) = row?.let { r -> sims.firstOrNull { it.first in r } } ?: sims.first()
        return Speaker(best, Math.round(sim * 1000) / 1000.0, basis = "strong")
    }
}

/** 강한 화자 값의 보관함과 등록. 화면(온보딩, 가족 추가)과 대조 스레드가 같이 쓴다. */
object Strong {
    @Volatile private var store: StrongPrints? = null
    fun prints(ctx: Context): StrongPrints = store ?: synchronized(this) { store ?: StrongPrints(ctx.filesDir, Live.seal(ctx)).also { store = it } }

    /** 등록 음성(16비트 LE 모노 PCM)에서 강한 값을 만들어 그 프로필에 둔다. 서버 등록이 끝난 뒤, 통신 스레드에서 부른다. 못 만들면 두지 않는다(1차 임베더만 씀). */
    fun enroll(ctx: Context, profileId: String, pcm: ByteArray) {
        val v = Wespeaker.of(ctx)?.embed(pcmSamples(pcm)) ?: return
        prints(ctx).put(profileId, v)
        Log.i("GachitaVoice", "강한 화자 값 등록(차 안에만 둠)") // 이름·값은 남기지 않는다
    }

    fun clear(ctx: Context) = prints(ctx).clear()
}

/**
 * 디버그 점검(adb … --ez voicecheck true): 이 기기에서 강한 화자 모델이 올라가고 값을 내는지 로그로 남긴다. 합성 신호 둘(음높이가 다른 톱니파)을 넣어
 * 차원, 걸린 시간, 같은 신호끼리·다른 신호끼리의 유사도를 적는다. 사람 목소리가 아니라 정확도 점검은 아니다.
 */
fun strongSelfCheck(ctx: Context): String {
    val e = Wespeaker.of(ctx) ?: return "강한 화자 모델을 올리지 못함"
    fun saw(period: Int, seed: Int) = FloatArray(RATE * 3) { i -> ((i % period) * 2f / period - 1f) * 0.4f + (((i * 1103515245L + seed) ushr 16) % 100 - 50) / 5000f }
    val t0 = System.currentTimeMillis()
    val a = e.embed(saw(133, 1)); val a2 = e.embed(saw(133, 7)); val b = e.embed(saw(53, 3))
    if (a == null || a2 == null || b == null) return "강한 화자 값을 내지 못함"
    return "강한 화자 모델 점검: 차원 ${a.size}, 3초 소리 셋에 ${System.currentTimeMillis() - t0}ms, 같은 신호 ${"%.3f".format(cosine(a, a2))}, 다른 신호 ${"%.3f".format(cosine(a, b))}"
}
