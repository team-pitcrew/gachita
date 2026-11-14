package io.github.teampitcrew.gachita

import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.Executors

/*
 * 여행 전체 음성 올리기(T132, ADR-0024, 오너 결정 11/15: 여행 뒤 올리고 다 올린 때부터 2일 보관).
 * 여행을 마치면(주차·종료, 녹음 안 함, 모두 동의) 이 차의 암호화 원음(Raw.kt)을 지금 동의 세대만 이어 붙여 A4 계약대로 올린다:
 * POST /audio/start {generation, expectedBytes, seconds, startedAt} → PUT /audio/parts/{n} 16 kHz 모노 s16le 4 MiB 조각(받은 조각은 partNumbers로 건너뜀)
 * → POST /audio/complete {generation, parts, seconds, sha256}. 진행은 C22가 보인다.
 * - 원음 파일 사이의 빈 곳(기록 멈춤)은 무음으로 채운다: 서버가 바이트 자리 = (시각 − startedAt) × 32로 장면을 자르므로 시각이 어긋나지 않게.
 * - 원음은 지우지 않는다(다 올린 뒤에도 차의 장면 클립 올리기가 쓴다). 409·410(동의 세대가 바뀜·지움·이미 다른 것)이면 이 세대는 멈추고 다시 하지 않는다.
 *   'expired'(2일이 지나 서버가 지움)면 끝난 것으로 보고 다시 올리지 않는다. 끊김·429·5xx는 1분 뒤 다음 조회에서 이어 올린다.
 */

internal const val AUDIO_PART = 4 * 1024 * 1024 // 조각 하나(서버 한도 4 MiB)
private const val PART_MS = AUDIO_PART / 32L // 131,072 ms(16 kHz × 16비트 = 32바이트/ms)
private const val AUDIO_MAX_MS = 8 * 3600 * 1000L // 서버 한도 8시간

/** 이어 붙일 시간축 [startedAt, endsAt) epoch ms. */
internal data class AudioPlan(val startedAt: Long, val endsAt: Long) {
    val bytes: Long get() = (endsAt - startedAt) * 32
    val seconds: Double get() = (endsAt - startedAt) / 1000.0
    val parts: Int get() = ((bytes + AUDIO_PART - 1) / AUDIO_PART).toInt()
    /** 조각 n이 덮는 시각 [from, to). */
    fun part(n: Int): Pair<Long, Long> = (startedAt + n * PART_MS) to minOf(endsAt, startedAt + (n + 1) * PART_MS)
}

/** 원음 파일들의 (첫 표본, 끝) → 첫 파일의 시작부터 마지막 파일의 끝까지. 없거나 8시간을 넘으면 null. */
internal fun audioPlan(spans: List<Pair<Long, Long>>): AudioPlan? {
    val ok = spans.filter { it.second > it.first }
    if (ok.isEmpty()) return null
    return AudioPlan(ok.minOf { it.first }, ok.maxOf { it.second }).takeIf { it.endsAt - it.startedAt <= AUDIO_MAX_MS }
}

/** 조각 n의 바이트: 무음(0)으로 채운 뒤 겹치는 파일의 소리를 제자리에 놓는다. cut(i, from, to)는 i번째 파일의 [from, to) 소리(없으면 null). */
internal fun audioPart(plan: AudioPlan, n: Int, spans: List<Pair<Long, Long>>, cut: (Int, Long, Long) -> ByteArray?): ByteArray {
    val (a, b) = plan.part(n)
    val out = ByteArray(((b - a) * 32).toInt())
    spans.forEachIndexed { i, (s, e) ->
        val from = maxOf(s, a); val to = minOf(e, b)
        if (to <= from) return@forEachIndexed
        val pcm = cut(i, from, to) ?: return@forEachIndexed
        val at = ((from - a) * 32).toInt()
        System.arraycopy(pcm, 0, out, at, minOf(pcm.size, out.size - at))
    }
    return out
}

internal enum class AudioState { IDLE, UPLOADING, READY, EXPIRED, NONE, STOPPED }

/** 이 차의 전체 음성 올리기 하나(앱 안에서 하나만). 상태는 C22가 읽는다. */
internal object FullAudio {
    var key by mutableStateOf("") // "<여행>:<세대>"
        private set
    var state by mutableStateOf(AudioState.IDLE)
        private set
    var progress by mutableStateOf(0f)
        private set
    var seconds by mutableStateOf(0.0) // 올리는·올린 전체 음성의 길이(C22의 주행 시간·눈금, 받아 적은 말이 없을 때)
        private set
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var busy = false
    @Volatile private var retryAt = 0L
    @Volatile private var settled = "" // 지났거나(expired) 멈춘(404·409·410) 여행·세대: 다시 하지 않는다
    private val uploaded = HashMap<String, Long>() // 여행·세대 → 다 올린 바이트. 원음이 늘면(다시 출발 뒤 주차) 새로 올린다(서버는 앞의 것을 새것이 끝날 때까지 둔다)

    private fun show(k: String, st: AudioState, p: Float, sec: Double? = null) = main.post { key = k; state = st; progress = p; if (sec != null) seconds = sec }

    /** 10초 조회마다 부른다. 이미 도는 중이거나 끝났거나 1분 안에 실패했으면 아무것도 하지 않는다. canUpload는 조각마다 다시 본다. */
    fun start(dir: File, seal: Seal, base: String, code: String, generation: Int, token: String, canUpload: () -> Boolean) {
        val k = "$code:$generation"
        if (busy || settled == k || System.currentTimeMillis() < retryAt) return
        busy = true
        io.execute {
            try { upload(dir, seal, Server(base), code, generation, token, canUpload, k) }
            catch (e: ApiError) {
                if (e.status in listOf(404, 409, 410)) { settled = k; show(k, AudioState.STOPPED, 0f) } // 404: 이 서버에 전체 음성 경로가 없음
                else retryAt = System.currentTimeMillis() + 60_000
                Log.i("GachitaAudio", "전체 음성 ${if (settled == k) "멈춤" else "미룸"} ${e.status}")
            } catch (e: Exception) { retryAt = System.currentTimeMillis() + 60_000; Log.i("GachitaAudio", "전체 음성 미룸 ${e.javaClass.simpleName}") }
            finally { busy = false }
        }
    }

    private fun upload(dir: File, seal: Seal, api: Server, code: String, generation: Int, token: String, canUpload: () -> Boolean, k: String) {
        val files = RawFile.of(dir, code).filter { it.generation == generation }.sortedBy { it.startedAt }
        val spans = files.map { it.startedAt to it.endsAt }
        val plan = audioPlan(spans)
        if (plan != null && uploaded[k] == plan.bytes) return // 이 앱에서 이미 다 올림(원음이 그대로)
        val now = api.audioStatus(code, token)
        val same = plan != null && now.optLong("expectedBytes") == plan.bytes && now.optLong("startedAt") == plan.startedAt
        when {
            now.optString("state") == "expired" -> { settled = k; show(k, AudioState.EXPIRED, 1f, now.optDouble("seconds", 0.0)); return }
            now.optBoolean("deleted") -> { settled = k; show(k, AudioState.STOPPED, 0f); return }
            now.optString("state") == "ready" && now.optInt("generation", generation) == generation && (plan == null || same) -> {
                plan?.let { uploaded[k] = it.bytes }; show(k, AudioState.READY, 1f, now.optDouble("seconds", 0.0)); return
            }
        }
        if (plan == null) { settled = k; show(k, AudioState.NONE, 0f); return }
        val started = api.audioStart(code, token, generation, plan.bytes, plan.seconds, plan.startedAt)
        val have = started.optJSONArray("partNumbers")?.let { a -> (0 until a.length()).map(a::getInt).toSet() } ?: emptySet()
        val sha = MessageDigest.getInstance("SHA-256")
        show(k, AudioState.UPLOADING, 0f, plan.seconds)
        for (n in 0 until plan.parts) {
            if (!canUpload()) { retryAt = System.currentTimeMillis() + 60_000; show(k, AudioState.IDLE, n.toFloat() / plan.parts); return } // 다시 출발·동의 철회
            val bytes = audioPart(plan, n, spans) { i, a, b -> files[i].cut(seal, a, b) }
            sha.update(bytes) // 받은 조각도 해시에 넣는다(완료는 전체의 sha256)
            if (n !in have) api.audioPart(code, token, n, generation, bytes)
            show(k, AudioState.UPLOADING, (n + 1f) / plan.parts * .99f)
        }
        api.audioComplete(code, token, generation, plan.parts, plan.seconds, sha.digest().joinToString("") { "%02x".format(it) })
        uploaded[k] = plan.bytes; show(k, AudioState.READY, 1f)
        Log.i("GachitaAudio", "전체 음성 ${plan.parts}조각 ${plan.bytes}바이트 올림")
    }
}

/** C22 첫 줄. 진행은 이 차가 올린 조각 수(받은 조각은 건너뛰며 셈). 합치기 전에는 99%를 넘기지 않는다. */
internal fun audioLabel(state: AudioState, progress: Float): String = when (state) {
    AudioState.UPLOADING -> "전체 음성 업로드 중  ${minOf(99, (progress * 100).toInt())}%"
    AudioState.READY -> "전체 음성 업로드 완료"
    AudioState.EXPIRED -> "전체 음성 보관 기간(2일)이 지났어요"
    AudioState.NONE -> "이 차에 남은 원음이 없어요"
    AudioState.STOPPED -> "전체 음성을 올리지 않아요"
    AudioState.IDLE -> "전체 음성 올리기를 준비하고 있어요"
}

internal fun audioNote(state: AudioState): String = when (state) {
    AudioState.UPLOADING, AudioState.IDLE -> "여행 음성을 업로드하고 추천 장면을 준비하고 있어요."
    AudioState.READY -> "전체 음성을 다 올렸어요. 남기고 싶은 장면을 골라 주세요."
    AudioState.EXPIRED -> "전체 음성은 지웠어요. 이미 고른 장면의 소리와 만든 콘텐츠는 그대로 남아요."
    AudioState.NONE -> "이 차에서 기록하지 않은 여행이에요. 받아 적은 대화로 장면을 추천해요."
    AudioState.STOPPED -> "동의가 바뀌었거나 지운 여행이라 전체 음성을 올리지 않아요. 받아 적은 대화로 장면을 추천해요."
}
