package io.github.teampitcrew.gachita

import android.content.Context
import android.util.Log
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractor
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractorConfig
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.math.sqrt

// 목소리의 둘째 값(강한 화자 값, 오너 11/15: '차에 강한 모델 넣기'). 1차 임베더(Voice.kt, 로그멜·음높이 통계)는 실제 목소리에서
// 같은 성별의 어른을 잘 가르지 못한다(시연 원천의 교정본 36줄: 늘 누군가로 정하면 22줄 맞음). 학습된 화자 모델(wespeaker resnet34,
// VoxCeleb, 256차원)을 차 안에서 돌리면 같은 줄에서 27줄이 맞았다(맥에서 같은 모델로 잰 값).
// - 실행기: sherpa-onnx 2.0.1(Apache-2.0)과 그 안의 ONNX Runtime. 모델 가중치는 wespeaker(CC BY 4.0). 둘 다 저장소에 넣지 않고 빌드 때 받는다(app/build.gradle).
// - 값은 등록하는 기기가 계산해 서버에 올린다(1차 값과 같은 경로, embedder: STRONG_EMBEDDER). 서버는 계산하지 않고 맡아 두었다가
//   대조 값 조회(GET /voice-prints)의 strong 칸으로 준다(ADR-0023). 폰에서 등록한 사람의 값도 그렇게 받는다. 등록 음성은 지금처럼 차를 떠나지 않는다.
// - 판정(VoicePrints.identifyStrong): 등록한 탑승자 모두가 둘째 값을 가졌을 때만 이것으로, 한 명이라도 없으면 1차 임베더의 규칙으로.
// - 라이브러리나 모델을 올리지 못하면(다른 ABI, 메모리 부족) 앱은 그대로 돌고 1차 임베더만 쓴다(둘째 값도 올리지 않는다).
// - 같은 모델이라도 기기마다 값이 조금 다를 수 있다(연산 순서). 이름(STRONG_EMBEDDER)은 서버 providers/voice.js와 같아야 한다.
const val STRONG_EMBEDDER = "wespeaker-resnet34-v1"
const val STRONG_DIMS = 256

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
            File(ctx.filesDir, "voice-strong.json").delete() // 앞선 빌드(T169)가 차 안에만 두던 값: 이제 서버가 맡으니 지운다
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

/** 둘째 값을 올리는 본문(1차 값의 voiceValue와 같은 경로). seconds는 서버가 받는 범위(0.5~20초)로 맞춘다. */
fun strongValue(v: FloatArray, seconds: Double): JSONObject =
    JSONObject().put("embedder", STRONG_EMBEDDER).put("vector", JSONArray().apply { v.forEach { put(it.toDouble()) } }).put("seconds", seconds.coerceIn(0.5, 20.0))

/** 등록 음성(16비트 LE 모노 PCM)의 둘째 값 본문. 1차 값을 올린 뒤 통신 스레드에서 부른다. 모델을 못 올리거나 값을 못 내면 null(1차 값만 씀). */
fun strongBody(ctx: Context, pcm: ByteArray): JSONObject? =
    Wespeaker.of(ctx)?.embed(pcmSamples(pcm))?.takeIf { it.size == STRONG_DIMS }?.let { strongValue(it, pcm.size / 2.0 / RATE) }

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
    // 맥(sherpa-onnx 2.0.1, 같은 모델 파일)이 같은 합성 신호 saw(133, 1)에 낸 값(assets/voicecheck.json)과 견준다: 차와 다른 기기의 값이 서로 견줄 만한지
    val ref = runCatching { JSONObject(ctx.assets.open("voicecheck.json").bufferedReader().readText()).getJSONArray("vector").let { j -> FloatArray(j.length()) { j.getDouble(it).toFloat() } } }.getOrNull()
    val same = ref?.takeIf { it.size == a.size }?.let { r -> "맥의 값과 유사도 ${"%.9f".format(cosine(a, r))}, 원소 최대 차이 ${"%.2e".format(a.indices.maxOf { kotlin.math.abs(a[it] - r[it]) })}" } ?: "맥의 기준 값 없음"
    return "강한 화자 모델 점검: 차원 ${a.size}, 3초 소리 셋에 ${System.currentTimeMillis() - t0}ms, 같은 신호 ${"%.3f".format(cosine(a, a2))}, 다른 신호 ${"%.3f".format(cosine(a, b))}, $same"
}
