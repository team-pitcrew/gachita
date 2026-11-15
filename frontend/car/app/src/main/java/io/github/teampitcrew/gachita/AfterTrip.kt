package io.github.teampitcrew.gachita

import android.content.Context
import android.util.Log
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.*
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

/*
 * 여행 마무리 → 추천 장면 고르기 → 생성 → 결과(최종 시안 C22–C32, 시연판 D21–D26·D補 select*, 흐름 F5). 폰은 frontend/web/after-trip.js.
 * 화면은 원본 Figma `Y7zFqGUEAFDWTumG30MsOs`를 11/15에 읽은 수치(T156). 색은 Material 역할, 글자는 CarText, 모양은 CarShape(CarDesign.kt).
 * - 처리 위치 원칙: 장면 후보는 차 안 규칙(Scenes.kt suggestScenes), 고른 장면은 POST /moments로 남기고(폰이 같은 기록을 읽음),
 *   장면 소리는 이 차가 이미 하는 장면 클립 올리기(MainActivity.clips, POST /recordings)로만 나간다.
 * - 영상(T158, ADR-0025): 서버 생성이 켜져 있으면 고른 장면으로 short-plans → short-generations를 맡기고(맥의 Codex 일꾼이 프로필 캐릭터
 *   최대 4명·구간 원음·자막으로 만듦) 완성될 때까지 진행을 본다. 꺼져 있으면(503) 기기 기본 영상(exportShortVideo) → short-assets.
 * - 전체 음성: 여행을 마치면 이 차가 원음 전체를 올린다(FullAudio.kt, T132, 다 올린 때부터 2일 보관). C22는 그 실제 진행을 보인다.
 * - 받아 적은 말은 이 차의 보관함(Live.outbox, 지금 동의 세대·글 있는 줄)에서 읽는다. 이 차가 받아 적지 않은 여행이면(줄이 4개 미만) 서버 기록본으로.
 */

// ---- 순수 함수(AfterTripTest) ----

/** 글 있는 한 줄. zone은 후보 규칙이 말한 사람으로 세는 값(차: 좌석 줄 "0"·"1" = 서버 seatArea, 서버 기록본: 참가자 id), person은 이름을 붙일 참가자 id. */
internal data class AfterLine(val key: Long, val at: Long, val text: String, val zone: String?, val person: String?, val lat: Double? = null, val lng: Double? = null)
/** line은 완성 표지(C32)의 큰 글(대사 줄 그대로). */
internal data class AfterPick(val number: Int, val from: Long, val to: Long, val at: Long, val title: String, val quote: String, val speakerId: String?, val lat: Double?, val lng: Double?,
    val line: String = "")

private fun two(n: Long) = n.toString().padStart(2, '0')
/** 여행 시작에서 잰 'HH:MM:SS'(시작 전은 0). */
internal fun afterClock(ms: Long): String { val s = maxOf(0L, ms / 1000); return "${two(s / 3600)}:${two(s % 3600 / 60)}:${two(s % 60)}" }
/** 파형 눈금 '34:12', 시간이 넘으면 '1:08:24'. */
internal fun afterAxis(ms: Long): String { val s = maxOf(0L, ms / 1000); val h = s / 3600; return (if (h > 0) "$h:" else "") + "${two(s % 3600 / 60)}:${two(s % 60)}" }
internal fun afterSpan(from: Long, to: Long, origin: Long) = "${afterClock(from - origin)}–${afterClock(to - origin)}"
/** '1시간 8분', '8분', '40초'. 모르면 빈 글. */
internal fun afterDuration(seconds: Long): String = when {
    seconds <= 0 -> ""
    seconds >= 3600 -> "${seconds / 3600}시간" + (seconds % 3600 / 60).let { if (it > 0) " ${it}분" else "" }
    seconds >= 60 -> "${seconds / 60}분"
    else -> "${seconds}초"
}

/** 추천 장면: 후보 점수 상위 n개를 시각 순으로(같은 점수면 앞선 장면). 후보 규칙은 5개까지(Scenes.kt), 3개는 화면의 몫. */
internal fun topPicks(cands: List<SceneCandidate>, n: Int = 3): List<SceneCandidate> =
    cands.filter { it.to > it.from }.sortedWith(compareByDescending<SceneCandidate> { it.score }.thenBy { it.from }).take(n).sortedBy { it.from }

private fun graphemes(s: String): List<String> {
    val it = java.text.BreakIterator.getCharacterInstance(Locale.KOREAN); it.setText(s)
    val out = ArrayList<String>(); var a = it.first(); var b = it.next()
    while (b != java.text.BreakIterator.DONE) { out += s.substring(a, b); a = b; b = it.next() }
    return out
}
internal fun clipText(s: String, max: Int): String { val g = graphemes(s.trim()); return if (g.size > max) g.take(max - 1).joinToString("").trim() + "…" else g.joinToString("") }

/** 장면에서 가장 힘 있는 한 줄: 글자 수(20자까지만), 물음표·느낌표로 끝남, 확인된 화자에 점수. 같으면 앞선 줄(폰 after-trip.js와 같은 규칙). */
internal fun strongestLine(lines: List<AfterLine>, known: Set<String>): AfterLine? {
    var best: AfterLine? = null; var top = Int.MIN_VALUE
    for (l in lines) {
        val t = l.text.trim(); if (t.isEmpty()) continue
        val score = minOf(20, graphemes(t).size) + (if (t.last() in "?!？！") 8 else 0) + (if (l.person != null && l.person in known) 4 else 0)
        if (score > top) { best = l; top = score }
    }
    return best
}

/** 카드 제목·대사(폰과 같음): 힘 있는 줄이 6자 이상이거나 화자를 모르면 그 말이 제목, 대사는 다른 첫 줄. 짧고 화자가 확인되면 '{이름}의 한마디'. */
internal fun pickTitle(lines: List<AfterLine>, names: Map<String, String>): Triple<String, String, String?> {
    val (line, other) = titleLines(lines, names) ?: return Triple("함께 나눈 이야기", "", null)
    val title = if (other !== line) clipText(line.text, 24) else "${line.person?.let { names[it] }}의 한마디"
    val quote = other?.let { o -> (o.person?.let { names[it] }?.let { "$it " } ?: "") + "“" + clipText(o.text, 30) + "”" } ?: ""
    return Triple(title, quote, line.person?.takeIf { it in names })
}

/** pickTitle이 고르는 (제목 줄, 대사 줄). 짧고 화자가 확인된 줄이면 둘이 같은 줄('{이름}의 한마디' + 그 말), 대사 줄이 없으면 null. */
private fun titleLines(lines: List<AfterLine>, names: Map<String, String>): Pair<AfterLine, AfterLine?>? {
    val line = strongestLine(lines, names.keys) ?: return null
    val asText = graphemes(line.text.trim()).size >= 6 || line.person?.let { names[it] } == null
    return line to (if (asText) lines.firstOrNull { it !== line && it.text.isNotBlank() } else line)
}

/** 후보 → 번호 붙은 추천 장면 3개. byKey는 후보의 SceneLine.seq → 글 있는 줄. */
internal fun afterPicks(cands: List<SceneCandidate>, byKey: Map<Long, AfterLine>, names: Map<String, String>): List<AfterPick> =
    topPicks(cands).mapIndexed { i, c ->
        val lines = c.lines.mapNotNull { byKey[it.seq] }
        val (title, quote, who) = pickTitle(lines, names)
        val line = titleLines(lines, names)?.let { (l, o) -> clipText((o ?: l).text, 30) }.orEmpty() // 표지 큰 글: 대사 줄(없으면 제목 줄)
        AfterPick(i + 1, c.from, c.to, c.at, title, quote, who, c.lat, c.lng, line)
    }

/** 시간축 막대: 칸마다 받아 적은 말의 수(최대 칸 대비 제곱근). 말이 없던 칸은 0(높이를 지어내지 않음). */
internal fun afterBars(ats: List<Long>, origin: Long, end: Long, count: Int = 56): List<Float> {
    val bins = IntArray(count); val w = (end - origin).toDouble() / count
    if (w <= 0) return List(count) { 0f }
    for (a in ats) if (a in origin..end) bins[minOf(count - 1, ((a - origin) / w).toInt())]++
    val max = bins.maxOrNull() ?: 0
    return bins.map { if (max == 0) 0f else Math.sqrt(it.toDouble() / max).toFloat() }
}

/** 장면 하나의 진행: 장면 남김 0.1 → 소리 준비 0.25 → 녹화 0.25~0.85 → 보관 0.9 → 완성 1(폰과 같음). */
internal enum class Phase { WAIT, MOMENT, VOICE, RENDER, SAVE, DONE, FAILED }
internal fun phaseProgress(p: Phase, render: Float = 0f): Float = when (p) {
    Phase.WAIT, Phase.MOMENT -> 0f; Phase.VOICE -> .1f; Phase.RENDER -> .25f + .6f * render.coerceIn(0f, 1f); Phase.SAVE -> .9f; Phase.DONE -> 1f; Phase.FAILED -> 0f
}

// ---- 만들기(탭을 옮겨도 이 앱이 켜져 있는 동안 계속) ----

internal class AfterItem(val pick: AfterPick) {
    val saveKey: String = UUID.randomUUID().toString() // short-assets 요청 키(다시 보내도 하나)
    var phase by mutableStateOf(Phase.WAIT)
    var render by mutableStateOf(0f)
    var momentId: String? = null
    var seconds by mutableStateOf(0.0)
    var cast by mutableStateOf<List<Int>>(emptyList()) // 만든 영상의 캐릭터 그림(shortSceneCast와 같은 둘) — 완성 표지 '목소리의 주인공'
    var error by mutableStateOf("")
}

internal class AfterRun(val code: String, val generation: Int, val items: List<AfterItem>, val people: List<Person> = emptyList()) {
    var job: Job? = null
    val active get() = job?.isActive == true
    val finished get() = items.all { it.phase == Phase.DONE || it.phase == Phase.FAILED }
}

/** 만들기를 멈춘 까닭을 그대로 보인다(로그에도 남김). 서버 거절·통신만 failureText로, 나머지는 예외의 글. */
internal fun afterError(e: Throwable): String = when (e) {
    is ApiError -> failureText(e)
    is java.io.IOException -> "서버에 닿지 않아요(${e.javaClass.simpleName})"
    else -> e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName
}

/** 서버 보관함 목록에서 이 장면·세대·원음으로 만든 같은 파일(sha256)이 보관 완료됐는지. 같은 요청 키를 다시 보내 409가 났을 때 성공으로 본다. */
internal fun storedShort(items: org.json.JSONArray, source: SharedShortSource, sha256: String): org.json.JSONObject? =
    (0 until items.length()).map { items.getJSONObject(it) }.firstOrNull {
        it.optString("origin") == "local-render" && it.optString("state") == "completed" && it.optString("momentId") == source.moment &&
            it.optInt("generation") == source.generation && it.optString("sourceHash") == source.hash && it.optJSONObject("result")?.optString("sha256") == sha256
    }

/** 서버 생성 요청 본문. 사람이 '선택한 장면 생성'을 누른 것이 외부 생성 확인이다(계획의 externalData: 글·캐릭터 그림만, 소리는 안 감). */
internal fun serverShortRequest(plan: org.json.JSONObject, generation: Int, key: String): org.json.JSONObject = org.json.JSONObject()
    .put("momentId", plan.getString("momentId")).put("templateId", plan.getString("templateId")).put("planHash", plan.getString("planHash"))
    .put("generation", generation).put("externalGenerationConsent", true).put("idempotencyKey", "car-$key")

/** 서버 생성 진행(0~1): 대기 5%, 만드는 중은 걸린 시간을 12분에 맞춰 95%까지(일꾼은 진행을 알리지 않는다), 완성 100%. */
internal fun serverShortProgress(state: String, elapsedMs: Long): Float = when (state) {
    "completed" -> 1f
    "generating", "composing" -> (.05f + .9f * elapsedMs / 720_000f).coerceAtMost(.95f)
    else -> .05f
}

private class AfterSourceChanged : IllegalStateException("원음·자막·화자가 바뀌었어요. 다시 만들어 주세요")
private class AfterStopped(message: String) : IllegalStateException(message)

internal object AfterRuns {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    var run by mutableStateOf<AfterRun?>(null)

    /**
     * allowed: 계속해도 되는가(같은 여행·세대·서버, 모두 동의, 주행 아님, 동의 끄기 대기 없음) — 거짓이면 바로 멈춘다.
     * ready: 지금 할 수 있는가(앱이 보임, 서버 연결, 주차) — 거짓이면 멈추지 않고 2분까지 기다린다.
     * 리허설 run1에서 렌더 뒤 한 번의 조회 실패(online=false)로 두 장면이 모두 '서버에 닿지 않아요'로 끝났다.
     */
    fun start(context: Context, base: String, token: String, run: AfterRun, allowed: () -> Boolean, ready: () -> Boolean) {
        this.run = run
        val app = context.applicationContext
        run.job = scope.launch {
            for (item in run.items) {
                if (item.phase == Phase.DONE) continue
                try { makeOne(app, base, token, run, item, allowed, ready) }
                catch (e: Throwable) {
                    if (e is kotlinx.coroutines.CancellationException && !isActive) throw e // 사람이 멈춤
                    Log.w("GachitaAfter", "장면 ${item.pick.number} 만들지 못함: ${e.javaClass.simpleName} ${e.message}", e)
                    item.phase = Phase.FAILED; item.error = afterError(e)
                }
                if (!allowed()) break
            }
        }
    }

    fun cancel() { run?.job?.cancel() }

    private suspend fun makeOne(context: Context, base: String, token: String, run: AfterRun, item: AfterItem, allowed: () -> Boolean, ready: () -> Boolean) {
        val api = Server(base); val shared = SharedShortApi(base)
        val job = currentCoroutineContext()[Job] // 기다림·다시 보냄 중에도 사람이 멈추면 바로 끝나게(gate는 렌더 콜백 안에서도 불려 suspend가 아님)
        // 계속해도 되는지 보고, 지금 할 수 없으면(앱이 가려짐·조회 한 번 실패·잠깐 D) 2분까지 기다린다
        fun gate() {
            var waited = 0
            while (true) {
                job?.ensureActive()
                if (!allowed()) throw AfterStopped("여행이나 기록 동의가 바뀌어 멈췄어요")
                if (ready()) return
                if (waited++ >= 120) throw AfterStopped("앱이 가려지거나 서버 연결이 2분 넘게 끊겨 멈췄어요")
                Thread.sleep(1000)
            }
        }
        // 통신 실패(IOException)·앞단의 잠깐 실패(502–504)는 세 번까지 다시 한다. 그 밖의 서버 거절은 그대로 던진다.
        fun <T> net(work: () -> T): T {
            var n = 0
            while (true) {
                gate()
                try { return work() } catch (e: Exception) {
                    if (e !is java.io.IOException && !(e is ApiError && e.transient) || ++n >= 4) throw e
                    Log.i("GachitaAfter", "다시 보냄 ${e.javaClass.simpleName} ${e.message}"); Thread.sleep(2000L * n)
                }
            }
        }
        gate()
        if (item.momentId == null) {
            item.phase = Phase.MOMENT
            val p = item.pick
            item.momentId = api.moment(run.code, token, p.at, p.from, p.to, clipText(p.title, 60), p.lat, p.lng) // 다시 보내면 장면이 둘이 될 수 있어 한 번만
        }
        val key = item.saveKey // 다시 보내도 서버 보관이 하나만 남게(같은 요청 키)
        for (attempt in 1..2) {
            // 장면 소리: 이 차가 원음에서 그 구간을 잘라 올리면(MainActivity.clips, 장면 구간이 끝나고 3초 뒤) 숏폼 구성에 보인다.
            item.phase = Phase.VOICE
            var source: SharedShortSource? = null
            while (source == null) {
                val form = parseShort(net { api.shortform(run.code, token) })
                if (form.generation != run.generation) throw AfterStopped("기록 동의가 바뀌어 멈췄어요")
                if (form.scenes.any { it.momentId == item.momentId }) source = runCatching { net { shared.source(run.code, token, item.momentId!!) } }.getOrNull()
                if (source == null) delay(3000)
            }
            if (source.generation != run.generation) throw AfterStopped("기록 동의가 바뀌어 멈췄어요")
            item.seconds = source.seconds; item.phase = Phase.RENDER; item.render = 0f
            item.cast = shortSceneCast(source.short, source.short.scenes.singleOrNull(), null, run.people).mapNotNull { it.character?.drawable }
            // 서버 생성(맥의 Codex 일꾼). 꺼져 있으면(503) 아래 기기 영상으로 간다.
            val plan = try { net { api.shortPlan(run.code, token, "car-sitcom-v1", false, item.momentId) } } catch (e: ApiError) { if (e.status == 503) null else throw e }
            val accepted = plan?.let { p -> try { net { api.createShortJob(run.code, token, serverShortRequest(p, run.generation, key)) } } catch (e: ApiError) { if (e.status == 503) null else throw e } }
            if (plan != null && accepted != null) {
                val cast = plan.optJSONArray("cast")
                item.cast = (0 until (cast?.length() ?: 0)).mapNotNull { i -> ShortCharacter.entries.firstOrNull { it.key == cast!!.getJSONObject(i).optString("character") }?.drawable }
                val started = System.currentTimeMillis()
                var job: org.json.JSONObject = accepted
                while (job.optString("state") !in setOf("completed", "failed", "canceled", "submission_unknown")) {
                    item.render = serverShortProgress(job.optString("state"), System.currentTimeMillis() - started)
                    delay(5000)
                    job = net { api.shortJob(run.code, token, accepted.getString("id")) }
                }
                if (job.optString("state") != "completed") throw AfterStopped("쇼츠를 만들지 못했어요(${job.optString("errorCode").ifBlank { job.optString("state") }})")
                item.render = 1f; item.phase = Phase.DONE
                return
            }
            val dir = File(context.cacheDir, "after-${UUID.randomUUID()}")
            val control = ShortExportControl()
            try {
                require(dir.mkdirs() || dir.isDirectory)
                val clip = File(dir, "source.wav")
                net { api.downloadShort(shortClipAddress(base, run.code, source.short.scenes.single().clip), token, clip, { !allowed() || control.isCancelled }, {}) }
                fun verify() { if (!sharedShortSame(source, net { shared.source(run.code, token, source.moment) })) throw AfterSourceChanged() }
                verify()
                val file = File(dir, "render.mp4")
                exportShortVideo(context, source.short, listOf(clip), emptyList(), control, beforePublish = ::verify, onProgress = { item.render = it }, targetFile = file, maxSeconds = 60)
                verify()
                item.phase = Phase.SAVE
                val hash = shortFileHash(file)
                fun stored() = storedShort(net { shared.list(run.code, token, run.generation) }, source, hash) != null
                var busy = 0
                while (true) {
                    try { net { shared.upload(run.code, token, source, file, key, hash) {} }; break }
                    catch (e: ApiError) {
                        // 리허설 run2: 올리기 IOException → 다시 보냄(서버 재시작) → 409. 처음 보낸 것이 보관됐으면 성공.
                        if (e.status != 409) throw e
                        if (stored()) { Log.i("GachitaAfter", "장면 ${item.pick.number}: 409지만 같은 영상이 이미 보관됨"); break }
                        // 같은 요청 키가 아직 '보관 중'(서버가 3분 잡아 둠)이면 목록을 보며 기다렸다 다시 보낸다. 다른 키·다른 영상·원음 바뀜은 실패.
                        if (!e.message.orEmpty().contains("이미 보관하고") || ++busy > 2) throw e // ponytail: 서버가 409 종류를 글로만 구분
                        var found = false
                        for (i in 1..20) { delay(10_000); gate(); if (stored()) { found = true; break } }
                        if (found) break
                    }
                }
                item.phase = Phase.DONE
                return
            } catch (e: AfterSourceChanged) {
                if (attempt == 2) throw e
                Log.i("GachitaAfter", "장면 ${item.pick.number}: 원음·자막이 바뀌어 다시 만듦")
            } finally { control.cancel(); dir.deleteRecursively() }
        }
    }
}

// ---- 화면 ----

internal enum class AfterStep { UPLOAD, SELECT, MAKE, DONE }

/**
 * C22–C32(원본 Figma 2005:3443–4441, 11/15 실시간 읽기). 여행 화면 틀(머리·위 탭)은 MainActivity가 그리고, 여기는 탭 아래 본문:
 * 제목 묶음 · 칸(높이 나머지) · 아래 큰 단추, 간격 24. C22·C31은 988 폭 한 칸을 가운데에, C23–C30은 전체 폭, C32는 완성 표지(400)를 가운데에 둔다.
 * 시연판 D21–D26은 C와 같은 틀이고 단추 글(D21 '대화 기록 확인', D25 '생성 결과 확인')·제목(D26 'N개의 순간이 완성됐어요')만 달라 C 글을 따른다.
 * lines는 글 있는 줄(시각 순), people은 여행 참가자. token은 동의한 이 차 참가자의 토큰. allowed·ready는 AfterRuns.start 참고.
 * onContents: 콘텐츠 기록(쇼츠 보관함)으로. 시작 화면은 step(대화 기록의 '추천 장면 고르기'는 SELECT).
 */
@Composable
internal fun AfterTrip(trip: Trip, lines: List<AfterLine>, base: String, token: String?, start: AfterStep, allowed: () -> Boolean, ready: () -> Boolean, onContents: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val c = MaterialTheme.colorScheme
    val names = remember(trip.people) { trip.people.associate { it.id to it.name } }
    val byKey = remember(lines) { lines.associateBy { it.key } }
    val picks = remember(lines, trip.moments) {
        afterPicks(suggestScenes(lines.map { SceneLine(it.key, it.at, it.zone, it.lat, it.lng) }, trip.moments), byKey, names)
    }
    val origin = lines.firstOrNull()?.at ?: trip.createdAt
    val end = maxOf(lines.lastOrNull()?.at ?: origin, picks.maxOfOrNull { it.to } ?: origin)
    val wave = remember(lines) { afterBars(lines.map { it.at }, origin, end, 64) } // C22·C31 파형 막대 64개
    val fine = remember(lines) { afterBars(lines.map { it.at }, origin, end, 120) } // C23–C30 파형 막대 120개
    val place by produceState<String?>(null, trip.code) { value = withContext(Dispatchers.IO) { parkedPlace(context, trip.code) } }
    // 무리 이름(동승 그룹이면 PITCREW): 차가 받는 여행 문서에는 그룹을 싣지 않아(server.js tripView) 콘텐츠 기록 응답에서 한 번 읽는다. 못 읽으면 '우리 가족'.
    val crew by produceState("우리 가족", trip.code, token) {
        if (token != null) runCatching { withContext(Dispatchers.IO) { parseContentTrip(org.json.JSONObject(Server(base).contents(trip.code, token))).crew } }.onSuccess { value = it }
    }
    val running = AfterRuns.run?.takeIf { it.code == trip.code && it.generation == trip.generation }
    var step by remember(trip.code, trip.generation) { mutableStateOf(if (running != null) AfterStep.MAKE else start) }
    if (step == AfterStep.MAKE && running?.finished == true && !running.active) step = AfterStep.DONE
    val chosen = remember(trip.code, trip.generation) { mutableStateListOf<Long>() }
    // 이 차의 전체 음성 올리기(FullAudio). 다른 여행·세대의 상태면 아직 시작 전.
    val mine = FullAudio.key == "${trip.code}:${trip.generation}"
    val audio = if (mine) FullAudio.state else AudioState.IDLE
    val upload = if (!mine) 0f else if (audio == AudioState.READY || audio == AudioState.EXPIRED) 1f else FullAudio.progress
    // 받아 적은 말이 없으면(이 차가 받아 적지 못함) 올린 전체 음성의 길이로 주행 시간과 눈금을 보인다
    val seconds = ((end - origin) / 1000).takeIf { it > 0 } ?: (if (mine) FullAudio.seconds.toLong() else 0L)
    val making = running != null && running.items.any { it.phase != Phase.DONE && it.phase != Phase.FAILED } && running.active
    val failed = running != null && !making && running.items.none { it.phase == Phase.DONE }
    fun toggle(k: Long) { if (k in chosen) chosen.remove(k) else chosen.add(k) }
    fun open() { if (!making) AfterRuns.run = null; onContents() } // 아직 만드는 중이면 실행을 남겨 둔다(돌아오면 진행이 보임)
    // C32 완성 표지 → 그 장면의 플레이어(시안 C37·player3): 콘텐츠 기록이 목록을 읽고 바로 연다(Contents.kt ContentLink)
    fun openScene(moment: String?) { ContentLink.moment = moment; open() }
    // C22: 전체 음성을 다 올렸거나(또는 올릴 것이 없으면) 5초 뒤 추천 장면으로(시안 C22 '5초 뒤 → C23'). 올리는 중에는 기다린다.
    LaunchedEffect(step, audio) {
        if (step == AfterStep.UPLOAD && audio in setOf(AudioState.READY, AudioState.EXPIRED, AudioState.NONE, AudioState.STOPPED)) { delay(5000); step = AfterStep.SELECT }
    }

    Column(modifier, verticalArrangement = Arrangement.spacedBy(24.dp)) {
        val (title, sub) = when (step) {
            AfterStep.UPLOAD -> "오늘의 주행을 기록했어요" to (place?.let { "$it 도착 / " }.orEmpty() + "주차 후 여행 마무리")
            AfterStep.SELECT -> "남기고 싶은 순간을 골라요" to "전체 음성에서 찾은 추천 장면 ${picks.size}개"
            AfterStep.MAKE -> "${crew}의 콘텐츠를 만들어요" to "선택한 장면에 캐릭터와 자막을 입히는 중"
            // 하나도 못 만들었으면 완성됐다고 하지 않는다(시안 밖 실패 상태 — 표지마다 까닭을 보임). C31에서 일찍 넘어와 아직 만드는 중이면 C31 글.
            AfterStep.DONE -> when {
                failed -> "콘텐츠를 만들지 못했어요" to "만들지 못한 까닭을 확인해 주세요."
                making -> "${crew}의 콘텐츠를 만들어요" to "선택한 장면에 캐릭터와 자막을 입히는 중"
                else -> "${crew}의 순간이 완성됐어요" to "선택한 장면을 콘텐츠 기록에 저장했어요."
            }
        }
        TitleBlock(title, sub, Modifier.fillMaxWidth())
        // C32는 '콘텐츠 기록 보기'가 제목 바로 아래, 표지 위(시안 하단 작업 y362·본문 y482)
        if (step == AfterStep.DONE) CarButton("콘텐츠 기록 보기", onClick = ::open)
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when (step) {
                AfterStep.UPLOAD -> Centered {
                    InfoCard(crew + afterDuration(seconds).let { if (it.isEmpty()) "" else " / $it" }, dayRange(origin, end), soft = true)
                    WaveCard(audioLabel(audio, upload), wave, seconds)
                    Text(audioNote(audio), style = CarText.Label, color = c.onSurfaceVariant)
                }
                AfterStep.SELECT -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Surface(Modifier.fillMaxWidth(), CarShape.Card, color = c.surface) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            Text("${trip.title.ifBlank { "함께 탄 여행" }} / 전체 ${afterClock(seconds * 1000)}", style = CarText.Label, color = c.onSurfaceVariant)
                            SceneWave(fine, picks, origin, end, chosen.toSet(), ::toggle)
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                listOf("00:00", afterAxis((end - origin) / 2), afterAxis(end - origin)).forEach { Text(it, style = CarText.Label, color = c.onSurfaceVariant) }
                            }
                        }
                    }
                    picks.forEach { p -> SceneRow(p, p.from in chosen, origin) { toggle(p.from) } }
                    // 추천 장면이 없으면(받아 적은 말이 없는 여행) 막다른 화면이 되지 않게 까닭과 콘텐츠 기록으로 가는 단추(시안 밖 상태)
                    if (picks.isEmpty()) Text("받아 적은 대화가 없어 추천할 장면을 찾지 못했어요.", style = CarText.Body, color = c.onSurfaceVariant)
                }
                AfterStep.MAKE -> Centered {
                    val r = running
                    if (r != null) {
                        val prepared = r.items.all { it.phase >= Phase.RENDER && it.phase != Phase.FAILED }
                        // 시안 C31의 상태 글. 음성 구간을 아직 준비하는 동안은 '준비 중', 멈추면(사람이 멈춤) '멈췄어요'
                        InfoCard(if (prepared) "음성 구간 준비 완료" else "음성 구간 준비 중", if (!r.active && !r.finished) "멈췄어요" else "캐릭터 배치와 자막 생성 중", soft = true)
                    }
                    WaveCard("콘텐츠 생성 중", wave, seconds)
                    Text("이 화면을 나가도 완성되면 알려드려요.", style = CarText.Label, color = c.onSurfaceVariant) // mock: 완성 알림은 아직 없다(다른 탭에서도 계속 만들고, 돌아오면 완성 화면)
                }
                AfterStep.DONE -> Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), contentAlignment = Alignment.TopCenter) {
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(24.dp)) { // 좁은 창이면 옆으로 넘김
                        running?.items?.forEachIndexed { i, item -> DoneScene(item, i, trip, names) { openScene(item.momentId) } }
                    }
                }
            }
        }
        val n = chosen.size
        when (step) {
            AfterStep.UPLOAD -> CarButton("추천 장면 보기") { step = AfterStep.SELECT }
            AfterStep.SELECT -> if (picks.isEmpty()) CarButton("콘텐츠 기록 보기", onClick = ::open)
            else CarButton(if (n == 0) "장면을 선택해 주세요" else "선택한 ${n}개 생성", enabled = n > 0 && token != null) {
                if (token != null && n > 0) {
                    val run = AfterRun(trip.code, trip.generation, picks.filter { it.from in chosen }.map(::AfterItem), trip.people)
                    AfterRuns.start(context, base, token, run, allowed, ready); step = AfterStep.MAKE
                }
            }
            AfterStep.MAKE -> CarButton("콘텐츠 기록으로") { step = AfterStep.DONE } // 시안 C31 → C32. 만드는 중이면 C32에서 표지마다 진행을 보인다
            AfterStep.DONE -> {} // 단추는 제목 아래
        }
    }
}

private fun dayRange(from: Long, to: Long): String {
    val day = SimpleDateFormat("M월 d일", Locale.KOREA); val hm = SimpleDateFormat("HH:mm", Locale.KOREA)
    return if (day.format(Date(from)) == day.format(Date(to))) "${day.format(Date(from))} ${hm.format(Date(from))}–${hm.format(Date(to))}"
    else "${day.format(Date(from))} ${hm.format(Date(from))} – ${day.format(Date(to))} ${hm.format(Date(to))}"
}

/**
 * C22 부제의 장소('강릉 숙소 도착'): 이 차의 장소 기록(Places.kt PlaceLog, places-<여행>.json)에 남은 마지막 도착·경유, 없으면 내비 목적지 이름. 읽기만 한다.
 * ponytail: PlaceLog에 읽기 함수가 생기면 그것으로(지금은 파일 모양을 여기서도 앎).
 */
private fun parkedPlace(context: Context, code: String): String? = runCatching {
    val o = org.json.JSONObject(Live.seal(context).unline(File(context.filesDir, "places-$code.json").readText()))
    o.optString("here").ifBlank { o.optString("dest") }.ifBlank { null }
}.getOrNull()

/** C22·C31의 '주요 내용': 988 폭 한 칸을 가운데에(간격 24). 좁은 창에서는 폭을 줄인다. */
@Composable
private fun Centered(content: @Composable ColumnScope.() -> Unit) = Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
    Column(Modifier.widthIn(max = 988.dp).fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(24.dp), content = content)
}

/** 파형 막대(시안 '파형'·'음성 파형'): 첫 막대는 왼쪽 끝, 마지막 막대는 오른쪽 끝에 붙고 사이는 고르게. 높이는 받아 적은 말의 양, 말이 없던 칸은 가장 낮은 막대. */
private fun DrawScope.waveBars(bars: List<Float>, width: Float, radius: Float, centerY: Float, low: Float, high: Float, color: Color) {
    if (bars.isEmpty()) return
    val pitch = if (bars.size > 1) (size.width - width) / (bars.size - 1) else 0f
    bars.forEachIndexed { i, v ->
        val h = maxOf(low, v * high)
        drawRoundRect(color, Offset(i * pitch, centerY - h / 2), Size(width, h), CornerRadius(radius, radius))
    }
}

/** C22·C31 '음성 타임라인': surface 카드(여백 28·간격 24) — 상태 글 · 파형 126(막대 64개, 폭 7.672, 모서리 3, accent) · '00:00'과 전체 길이. */
@Composable
private fun WaveCard(label: String, bars: List<Float>, seconds: Long) {
    val c = MaterialTheme.colorScheme
    Surface(Modifier.fillMaxWidth(), CarShape.Card, color = c.surface) {
        Column(Modifier.padding(28.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            Text(label, style = CarText.Label, color = c.onSurfaceVariant)
            Canvas(Modifier.fillMaxWidth().height(126.dp)) { waveBars(bars, 7.672.dp.toPx(), 3.dp.toPx(), size.height / 2, 10.dp.toPx(), 104.dp.toPx(), c.primary) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("00:00", style = CarText.Label, color = c.onSurfaceVariant)
                Text(afterClock(seconds * 1000), style = CarText.Label, color = c.onSurfaceVariant)
            }
        }
    }
}

/**
 * C23–C30 '파형 / 추천 1·2·3 구간과 선택 핸들'(높이 166): 막대 120개(폭 6, 모서리 2, ink-2 55%, 가운데 y 118, 높이 10–73),
 * 구간(y 64, 높이 100 — 고르면 accent, 아니면 accent-soft 55%)과 양 끝 경계(y 62, 높이 104 — 고르면 accent 3, 아니면 ink-2 1),
 * 구간 위 가운데 번호 칩(54×44, 모서리 12, y 8 — 고르면 accent/on-accent, 아니면 surface-2/ink). 칩을 눌러도 목록과 같은 선택이 바뀐다.
 */
@Composable
private fun SceneWave(bars: List<Float>, picks: List<AfterPick>, origin: Long, end: Long, chosen: Set<Long>, onToggle: (Long) -> Unit) {
    val c = MaterialTheme.colorScheme
    fun at(t: Long) = if (end > origin) ((t - origin).toFloat() / (end - origin)).coerceIn(0f, 1f) else 0f
    BoxWithConstraints(Modifier.fillMaxWidth().height(166.dp)) {
        val w = maxWidth
        Canvas(Modifier.fillMaxSize()) {
            waveBars(bars, 6.dp.toPx(), 2.dp.toPx(), 118.dp.toPx(), 10.dp.toPx(), 73.dp.toPx(), c.onSurfaceVariant.copy(alpha = .55f))
            picks.forEach { p ->
                val on = p.from in chosen
                val edge = (if (on) 3 else 1).dp.toPx()
                val x0 = minOf(size.width * at(p.from), size.width - 2 * edge)
                val x1 = (size.width * at(p.to)).coerceIn(x0 + edge, size.width - edge)
                drawRect(if (on) c.primary else c.primaryContainer.copy(alpha = .55f), Offset(x0, 64.dp.toPx()), Size(x1 - x0, 100.dp.toPx()))
                val line = if (on) c.primary else c.onSurfaceVariant
                drawRect(line, Offset(x0, 62.dp.toPx()), Size(edge, 104.dp.toPx()))
                drawRect(line, Offset(x1, 62.dp.toPx()), Size(edge, 104.dp.toPx()))
            }
        }
        // 구간 막대도 누르면 그 장면을 고르거나 푼다(시안 '구간 1 / 724–756초' → C24). 칩보다 먼저 두어 칩이 위에 온다.
        picks.forEach { p ->
            val x0 = w * at(p.from)
            Box(Modifier.offset(x = x0, y = 62.dp).size(maxOf(w * at(p.to) - x0, 24.dp), 104.dp).clickable { onToggle(p.from) })
        }
        picks.forEach { p ->
            val on = p.from in chosen
            val mid = w * ((at(p.from) + at(p.to)) / 2)
            Surface(onClick = { onToggle(p.from) }, shape = RoundedCornerShape(12.dp), color = if (on) c.primary else c.surfaceVariant,
                modifier = Modifier.offset(x = (mid - 27.dp).coerceIn(0.dp, maxOf(0.dp, w - 54.dp)), y = 8.dp).size(54.dp, 44.dp)
                    .semantics { contentDescription = "${p.number}번 장면 ${if (on) "선택 해제" else "선택"}" }) {
                Box(contentAlignment = Alignment.Center) { Text("${p.number}", style = CarText.Label, color = if (on) c.onPrimary else c.onSurface) }
            }
        }
    }
}

/**
 * C23–C30 장면 행(전체 폭, 여백 16, 간격 6, 모서리 32 — 고르면 accent-soft, 아니면 surface): '☐/☑ N. 제목'(Headline 32, ink) · '시작–끝 / “대사”'(Label 24, ink-2).
 * 체크는 시안처럼 글자 기호(Pretendard에 없어 시스템 기호 글꼴로 그려짐).
 */
@Composable
private fun SceneRow(p: AfterPick, on: Boolean, origin: Long, onClick: () -> Unit) {
    val c = MaterialTheme.colorScheme
    Surface(onClick = onClick, shape = CarShape.Card, color = if (on) c.primaryContainer else c.surface,
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = "${p.number}번 장면 ${if (on) "선택됨" else "선택 안 됨"}" }) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("${if (on) "☑" else "☐"} ${p.number}. ${p.title}", style = CarText.Headline, color = c.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
            // 시안은 따옴표 대사만('“아빠, 아까부터 바다 보이는데?”'). pickTitle의 대사는 폰과 같은 모양('서준 “…”')이라 이름은 떼고 보인다.
            val said = p.quote.substring(p.quote.indexOf('“').coerceAtLeast(0))
            Text(afterSpan(p.from, p.to, origin) + if (said.isNotEmpty()) " / $said" else "", style = CarText.Label, color = c.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** 시안 'Archive / galleryCar' 표지 글(시안 값 그대로): 머리·발 Medium 18.75/27.5, 대사 Bold 40/55(자간 -2%), 설명 Regular 16.25/22.5. */
private val PosterSmall = CarText.Label.copy(fontSize = 18.75.sp, lineHeight = 27.5.sp)
private val PosterLine = CarText.Title.copy(lineHeight = 55.sp)
private val PosterCaption = CarText.Label.copy(fontWeight = FontWeight.Normal, fontSize = 16.25.sp, lineHeight = 22.5.sp)

/**
 * C32 '완성 장면'(폭 400, 간격 16): 표지 'Archive / galleryCar' 400×550(여백 30, 간격 20, 모서리 25, 종이 tint-2부터 차례로) — '날짜  여행 제목' · 대사 줄 ·
 * 여백 · '목소리의 주인공'(만든 영상의 캐릭터 140 둘, 간격 15) · 설명 · '가치타'와 '▶ 길이' — 그 아래 장면 제목(Headline 32). 누르면 그 장면의 플레이어(C37·player3).
 * 설명 줄(시안 '서준의 한마디에 모두 웃음')은 서버에 장면 설명이 없어 콘텐츠 기록 표지(Contents.kt coverOf)와 같은 규칙: 말한 사람이 있으면 '{이름}의 한마디', 없으면 여행 제목.
 * 아직 만드는 장면(C31에서 일찍 넘어옴)과 만들지 못한 장면(시안 밖 상태)은 어두운 표지에 진행이나 까닭을 적는다.
 */
@Composable
private fun DoneScene(item: AfterItem, index: Int, trip: Trip, names: Map<String, String>, onOpen: () -> Unit) {
    val c = MaterialTheme.colorScheme
    val ok = item.phase == Phase.DONE
    val p = item.pick
    val ink = if (ok) CarPaper.Ink else c.onSurface
    val ink2 = if (ok) CarPaper.Ink2 else c.onSurfaceVariant
    Column(Modifier.width(400.dp).then(if (ok) Modifier.clickable(onClick = onOpen) else Modifier), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Surface(Modifier.fillMaxWidth().height(550.dp), RoundedCornerShape(25.dp), color = if (ok) CarPaper.Tints[(index + 1) % CarPaper.Tints.size] else c.surface) {
            Column(Modifier.padding(30.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                Text("${SimpleDateFormat("M.d", Locale.KOREA).format(Date(p.at))}  ${trip.title.ifBlank { "함께 탄 여행" }}", style = PosterSmall, color = ink2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(p.line.ifEmpty { p.title }, style = PosterLine, color = ink, maxLines = 4, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.weight(1f))
                if (ok) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(15.dp, Alignment.CenterHorizontally)) {
                        item.cast.take(2).forEach { CharAvatar(it, 140.dp) }
                    }
                    Text(p.speakerId?.let { names[it] }?.takeIf { it.isNotBlank() }?.let { "${it}의 한마디" } ?: trip.title.ifBlank { "함께 탄 여행" },
                        Modifier.fillMaxWidth(), style = PosterCaption, color = ink2, textAlign = TextAlign.Center, maxLines = 1)
                    Row(Modifier.fillMaxWidth()) {
                        Text("가치타", style = PosterSmall, color = ink2)
                        Spacer(Modifier.weight(1f))
                        val s = item.seconds.toLong()
                        Text("▶ ${s / 60}:${two(s % 60)}", style = PosterSmall, color = ink)
                    }
                } else if (item.phase == Phase.FAILED) {
                    Text("만들지 못했어요", style = CarText.Headline, color = ink)
                    Text(item.error, style = CarText.Label, color = ink2, maxLines = 4, overflow = TextOverflow.Ellipsis)
                } else {
                    Text("만드는 중", style = CarText.Headline, color = ink)
                    Text("${(phaseProgress(item.phase, item.render) * 100).toInt()}%", style = CarText.Label, color = ink2)
                }
            }
        }
        Text(p.title, style = CarText.Headline, color = c.onSurface, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * 이 차의 보관함(Outbox.recent, 고치지 않고 읽기만)에서 지금 동의 세대의 글 있는 줄. 후보 규칙의 말한 사람은 좌석 줄("0" 앞줄·"1" 뒷줄, 서버 seatArea와 같은 자리).
 * 이름은 서버 기록본의 같은 시각 줄에서. 이 차가 받아 적지 않은 여행이면(4줄 미만) 서버 기록본으로(말한 사람은 참가자 id).
 * ponytail: T144의 Outbox.lines()가 들어오면 그것으로 바꾼다.
 */
internal fun afterLines(context: Context, trip: Trip, server: List<TranscriptLine>): List<AfterLine> {
    val heard = server.associate { it.at to it.participantId }
    val local = runCatching { Live.outbox(context, trip.code).recent(Int.MAX_VALUE) }.getOrDefault(emptyList())
        .filter { it.generation == trip.generation && it.text.isNotBlank() }
        .map { u -> AfterLine(u.seq, u.startedAt, u.text, u.seatZone?.toString(), heard[u.startedAt], u.lat, u.lng) }
    if (local.size >= 4) return local.sortedBy { it.at }
    return server.filter { it.text.isNotBlank() }.sortedBy { it.at }.mapIndexed { i, l -> AfterLine(i + 1L, l.at, l.text, l.participantId, l.participantId) }
}
