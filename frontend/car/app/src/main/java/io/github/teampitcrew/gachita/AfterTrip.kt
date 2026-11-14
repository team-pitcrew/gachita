package io.github.teampitcrew.gachita

import android.content.Context
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

/*
 * 여행 마무리 → 추천 장면 고르기 → 생성 → 결과(최종 시안 C22–C32, 흐름 F5). 폰은 frontend/web/after-trip.js.
 * - 처리 위치 원칙: 장면 후보는 차 안 규칙(Scenes.kt suggestScenes), 고른 장면은 POST /moments로 남기고(폰이 같은 기록을 읽음),
 *   장면 소리는 이 차가 이미 하는 장면 클립 올리기(MainActivity.clips, POST /recordings)로만 나간다. 영상은 기기 기본 영상(exportShortVideo) → short-assets.
 * - mock: 전체 음성 실제 업로드는 오너의 보관 결정 전까지 끈다(계획 '속도 우선' ③). C22의 진행률은 시간으로 흉내 내고, 차는 /audio를 부르지 않는다.
 * - 받아 적은 말은 이 차의 보관함(Live.outbox, 지금 동의 세대·글 있는 줄)에서 읽는다. 이 차가 받아 적지 않은 여행이면(줄이 4개 미만) 서버 기록본으로.
 */

// ---- 순수 함수(AfterTripTest) ----

/** 글 있는 한 줄. zone은 후보 규칙이 말한 사람으로 세는 값(차: 좌석 줄 "0"·"1" = 서버 seatArea, 서버 기록본: 참가자 id), person은 이름을 붙일 참가자 id. */
internal data class AfterLine(val key: Long, val at: Long, val text: String, val zone: String?, val person: String?, val lat: Double? = null, val lng: Double? = null)
internal data class AfterPick(val number: Int, val from: Long, val to: Long, val at: Long, val title: String, val quote: String, val speakerId: String?, val lat: Double?, val lng: Double?)

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
    val line = strongestLine(lines, names.keys) ?: return Triple("함께 나눈 이야기", "", null)
    val person = line.person?.let { names[it] }
    val text = line.text.trim(); val asText = graphemes(text).size >= 6 || person == null
    val title = if (asText) clipText(text, 24) else "${person}의 한마디"
    val other = if (asText) lines.firstOrNull { it !== line && it.text.isNotBlank() } else line
    val quote = other?.let { o -> (o.person?.let { names[it] }?.let { "$it " } ?: "") + "“" + clipText(o.text, 30) + "”" } ?: ""
    return Triple(title, quote, line.person?.takeIf { it in names })
}

/** 후보 → 번호 붙은 추천 장면 3개. byKey는 후보의 SceneLine.seq → 글 있는 줄. */
internal fun afterPicks(cands: List<SceneCandidate>, byKey: Map<Long, AfterLine>, names: Map<String, String>): List<AfterPick> =
    topPicks(cands).mapIndexed { i, c ->
        val (title, quote, who) = pickTitle(c.lines.mapNotNull { byKey[it.seq] }, names)
        AfterPick(i + 1, c.from, c.to, c.at, title, quote, who, c.lat, c.lng)
    }

/** 시간축 막대: 칸마다 받아 적은 말의 수(최대 칸 대비 제곱근). 말이 없던 칸은 0(높이를 지어내지 않음). */
internal fun afterBars(ats: List<Long>, origin: Long, end: Long, count: Int = 56): List<Float> {
    val bins = IntArray(count); val w = (end - origin).toDouble() / count
    if (w <= 0) return List(count) { 0f }
    for (a in ats) if (a in origin..end) bins[minOf(count - 1, ((a - origin) / w).toInt())]++
    val max = bins.maxOrNull() ?: 0
    return bins.map { if (max == 0) 0f else Math.sqrt(it.toDouble() / max).toFloat() }
}

// mock: 실제 업로드가 꺼진 동안 C22에 보일 진행(시안 '전체 음성 업로드 중 82%'). 화면을 처음 연 때부터 ms 동안 0→1.
internal const val MOCK_UPLOAD_MS = 12_000L
internal fun mockUploadProgress(openedAt: Long, now: Long, ms: Long = MOCK_UPLOAD_MS): Float = ((now - openedAt).toFloat() / ms).coerceIn(0f, 1f)

/** 장면 하나의 진행: 장면 남김 0.1 → 소리 준비 0.25 → 녹화 0.25~0.85 → 보관 0.9 → 완성 1(폰과 같음). */
internal enum class Phase { WAIT, MOMENT, VOICE, RENDER, SAVE, DONE, FAILED }
internal fun phaseProgress(p: Phase, render: Float = 0f): Float = when (p) {
    Phase.WAIT, Phase.MOMENT -> 0f; Phase.VOICE -> .1f; Phase.RENDER -> .25f + .6f * render.coerceIn(0f, 1f); Phase.SAVE -> .9f; Phase.DONE -> 1f; Phase.FAILED -> 0f
}

// ---- 만들기(탭을 옮겨도 이 앱이 켜져 있는 동안 계속) ----

internal class AfterItem(val pick: AfterPick) {
    var phase by mutableStateOf(Phase.WAIT)
    var render by mutableStateOf(0f)
    var momentId: String? = null
    var seconds by mutableStateOf(0.0)
    var error by mutableStateOf("")
}

internal class AfterRun(val code: String, val generation: Int, val items: List<AfterItem>) {
    var job: Job? = null
    val active get() = job?.isActive == true
    val finished get() = items.all { it.phase == Phase.DONE || it.phase == Phase.FAILED }
}

internal object AfterRuns {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    var run by mutableStateOf<AfterRun?>(null)

    fun start(context: Context, base: String, token: String, run: AfterRun, canUse: () -> Boolean) {
        this.run = run
        val app = context.applicationContext
        run.job = scope.launch {
            for (item in run.items) {
                if (item.phase == Phase.DONE) continue
                try { makeOne(app, base, token, run, item, canUse) }
                catch (e: CancellationException) { throw e }
                catch (e: Exception) { item.phase = Phase.FAILED; item.error = failureText(e) }
                if (!canUse()) break
            }
        }
    }

    fun cancel() { run?.job?.cancel() }

    private suspend fun makeOne(context: Context, base: String, token: String, run: AfterRun, item: AfterItem, canUse: () -> Boolean) {
        val api = Server(base); val shared = SharedShortApi(base)
        fun check() { check(canUse()) { "주차 상태와 모두의 기록 동의를 확인해 주세요" } }
        check()
        if (item.momentId == null) {
            item.phase = Phase.MOMENT
            val p = item.pick
            item.momentId = api.moment(run.code, token, p.at, p.from, p.to, clipText(p.title, 60), p.lat, p.lng)
        }
        // 장면 소리: 이 차가 원음에서 그 구간을 잘라 올리면(MainActivity.clips, 장면 구간이 끝나고 3초 뒤) 숏폼 구성에 보인다.
        item.phase = Phase.VOICE
        var source: SharedShortSource? = null
        while (source == null) {
            check()
            val form = parseShort(api.shortform(run.code, token))
            check(form.generation == run.generation) { "기록 동의가 바뀌어 멈췄어요" }
            if (form.scenes.any { it.momentId == item.momentId }) source = runCatching { shared.source(run.code, token, item.momentId!!) }.getOrNull()
            if (source == null) delay(3000)
        }
        check(source.generation == run.generation)
        item.seconds = source.seconds; item.phase = Phase.RENDER; item.render = 0f
        val dir = File(context.cacheDir, "after-${UUID.randomUUID()}")
        val control = ShortExportControl()
        try {
            require(dir.mkdirs() || dir.isDirectory)
            val clip = File(dir, "source.wav")
            api.downloadShort(shortClipAddress(base, run.code, source.short.scenes.single().clip), token, clip, { !canUse() || control.isCancelled }, {})
            fun verify() { check(); check(sharedShortSame(source, shared.source(run.code, token, source.moment))) { "원음·자막·화자가 바뀌었어요. 다시 만들어 주세요" } }
            verify()
            val file = File(dir, "render.mp4")
            exportShortVideo(context, source.short, listOf(clip), emptyList(), control, beforePublish = ::verify, onProgress = { item.render = it }, targetFile = file, maxSeconds = 60)
            verify()
            item.phase = Phase.SAVE
            shared.upload(run.code, token, source, file, UUID.randomUUID().toString(), shortFileHash(file)) {}
            item.phase = Phase.DONE
        } finally { control.cancel(); dir.deleteRecursively() }
    }
}

// ---- 화면 ----

internal enum class AfterStep { UPLOAD, SELECT, MAKE, DONE }

/**
 * C22–C32. lines는 글 있는 줄(시각 순), people은 여행 참가자. token은 동의한 이 차 참가자의 토큰. canUse: 주차·모두 동의·같은 여행.
 * onContents: 콘텐츠 기록(쇼츠 보관함)으로. 시작 화면은 step(대화 기록의 '추천 장면 고르기'는 SELECT).
 */
@Composable
internal fun AfterTrip(trip: Trip, lines: List<AfterLine>, base: String, token: String?, start: AfterStep, canUse: () -> Boolean, onContents: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val c = MaterialTheme.colorScheme
    val names = remember(trip.people) { trip.people.associate { it.id to it.name } }
    val byKey = remember(lines) { lines.associateBy { it.key } }
    val picks = remember(lines, trip.moments) {
        afterPicks(suggestScenes(lines.map { SceneLine(it.key, it.at, it.zone, it.lat, it.lng) }, trip.moments), byKey, names)
    }
    val origin = lines.firstOrNull()?.at ?: trip.createdAt
    val end = maxOf(lines.lastOrNull()?.at ?: origin, picks.maxOfOrNull { it.to } ?: origin)
    val bars = remember(lines) { afterBars(lines.map { it.at }, origin, end) }
    val running = AfterRuns.run?.takeIf { it.code == trip.code && it.generation == trip.generation }
    var step by remember(trip.code, trip.generation) { mutableStateOf(if (running != null) AfterStep.MAKE else start) }
    if (step == AfterStep.MAKE && running?.finished == true && !running.active) step = AfterStep.DONE
    val chosen = remember(trip.code, trip.generation) { mutableStateListOf<Long>() }
    // mock: C22 진행률. 처음 연 때부터 12초.
    val openedAt = remember(trip.code, trip.generation) { System.currentTimeMillis() }
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(step) { while (step == AfterStep.UPLOAD || step == AfterStep.MAKE) { now = System.currentTimeMillis(); delay(500) } }
    val upload = mockUploadProgress(openedAt, now)
    val seconds = (end - origin) / 1000

    Column(modifier, verticalArrangement = Arrangement.spacedBy(20.dp)) {
        val (title, sub) = when (step) {
            AfterStep.UPLOAD -> "오늘의 주행을 기록했어요" to (if (trip.status == "ended") "여행을 마쳤어요" else "주차 후 여행 마무리")
            AfterStep.SELECT -> "남기고 싶은 순간을 골라요" to (if (picks.isEmpty()) "아직 추천할 장면을 찾지 못했어요" else "받아 적은 대화에서 찾은 추천 장면 ${picks.size}개")
            AfterStep.MAKE -> "우리의 콘텐츠를 만들어요" to "선택한 장면에 캐릭터와 자막을 입히는 중"
            AfterStep.DONE -> "우리의 순간이 완성됐어요" to "선택한 장면을 콘텐츠 기록에 저장했어요."
        }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, fontSize = 40.sp, lineHeight = 52.sp, fontWeight = FontWeight.Bold)
            Text(sub, fontSize = 24.sp, color = c.onSurfaceVariant)
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when (step) {
                AfterStep.UPLOAD -> Split(trip) {
                    Summary("우리 일행 ${trip.people.size}명" + afterDuration(seconds).let { if (it.isEmpty()) "" else " / $it" }, dayRange(origin, end))
                    WaveCard(if (upload >= 1f) "전체 음성 업로드 완료" else "전체 음성 업로드 중  ${minOf(99, (upload * 100).toInt())}%", bars, upload, seconds)
                    Text(if (upload >= 1f) "추천 장면을 골라 주세요." else "여행 음성을 업로드하고 추천 장면을 준비하고 있어요.", fontSize = 24.sp, color = c.onSurfaceVariant)
                }
                AfterStep.SELECT -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    PickWave("${trip.title.ifBlank { "함께 탄 여행" }} / 전체 ${afterClock(seconds * 1000)}", bars, picks, origin, end, chosen.toSet()) { k -> if (k in chosen) chosen.remove(k) else chosen.add(k) }
                    picks.forEach { p ->
                        val on = p.from in chosen
                        Surface(onClick = { if (on) chosen.remove(p.from) else chosen.add(p.from) }, shape = RoundedCornerShape(32.dp), color = if (on) c.primaryContainer else c.surface,
                            modifier = Modifier.fillMaxWidth().semantics { contentDescription = "${p.number}번 장면 ${if (on) "선택됨" else "선택 안 됨"}" }) {
                            Row(Modifier.padding(horizontal = 24.dp, vertical = 18.dp), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                                Checkbox(on, { if (on) chosen.remove(p.from) else chosen.add(p.from) })
                                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                    Text("${p.number}. ${p.title}", fontSize = 32.sp, lineHeight = 42.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Text(afterSpan(p.from, p.to, origin) + if (p.quote.isNotEmpty()) " / ${p.quote}" else "", fontSize = 24.sp, color = c.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                            }
                        }
                    }
                    if (picks.isEmpty()) Text("대화가 더 쌓이면 다시 찾아요.", fontSize = 24.sp, color = c.onSurfaceVariant)
                }
                AfterStep.MAKE, AfterStep.DONE -> {
                    val r = running
                    Split(trip) {
                        if (r == null) Text("만들 장면이 없어요.", fontSize = 24.sp)
                        else if (step == AfterStep.MAKE) {
                            val ready = r.items.count { it.phase >= Phase.RENDER && it.phase != Phase.FAILED }
                            val now2 = r.items.firstOrNull { it.phase in Phase.MOMENT..Phase.SAVE }
                            val overall = r.items.sumOf { phaseProgress(it.phase, it.render).toDouble() }.toFloat() / r.items.size
                            Summary(if (ready == r.items.size) "음성 구간 준비 완료" else "음성 구간 준비 중 · $ready/${r.items.size}",
                                when (now2?.phase) {
                                    Phase.RENDER -> "캐릭터 배치와 자막 생성 중 · ${r.items.indexOf(now2) + 1}/${r.items.size}"
                                    Phase.SAVE -> "콘텐츠 기록에 저장 중"
                                    Phase.VOICE -> "이 차가 장면 소리를 잘라 올리는 중"
                                    Phase.MOMENT -> "고른 장면을 남기는 중"
                                    else -> if (r.active) "준비 중" else "멈췄어요"
                                })
                            WaveCard("콘텐츠 생성 중  ${(overall * 100).toInt()}%", bars, overall, seconds)
                            Text("다른 탭으로 가도 이 차에서 계속 만들어요. 앱을 닫거나 주행을 시작하면 멈춰요.", fontSize = 24.sp, color = c.onSurfaceVariant)
                        } else {
                            r.items.forEachIndexed { i, item ->
                                Surface(shape = RoundedCornerShape(32.dp), color = if (i % 2 == 0) c.secondaryContainer else c.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
                                    Row(Modifier.padding(24.dp), horizontalArrangement = Arrangement.spacedBy(20.dp), verticalAlignment = Alignment.CenterVertically) {
                                        val who = trip.people.firstOrNull { it.id == item.pick.speakerId }
                                        Character(who?.let(::seatCharacter) ?: i, 88.dp)
                                        Column {
                                            Text(item.pick.title, fontSize = 32.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                            Text(if (item.phase == Phase.DONE) "${item.seconds.toInt()}초 / 캐릭터 자막형" else "만들지 못했어요 · ${item.error}", fontSize = 24.sp, color = c.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                        }
                                    }
                                }
                            }
                            Text("같은 계정의 폰에서도 바로 볼 수 있어요.", fontSize = 24.sp, color = c.onSurfaceVariant)
                        }
                    }
                }
            }
        }
        val n = chosen.size
        val button = when (step) {
            AfterStep.UPLOAD -> DriveButton("추천 장면 보기", Press.GO, true)
            AfterStep.SELECT -> if (n == 0) DriveButton("장면을 선택해 주세요", Press.OFF, false) else DriveButton("선택한 ${n}개 생성", if (token != null) Press.GO else Press.OFF, token != null)
            AfterStep.MAKE -> DriveButton("콘텐츠 기록으로", Press.GO, true)
            AfterStep.DONE -> DriveButton("콘텐츠 기록 보기", Press.GO, true)
        }
        BigButton(button, {
            when (step) {
                AfterStep.UPLOAD -> step = AfterStep.SELECT
                AfterStep.SELECT -> if (token != null && n > 0) {
                    val run = AfterRun(trip.code, trip.generation, picks.filter { it.from in chosen }.map(::AfterItem))
                    AfterRuns.start(context, base, token, run, canUse); step = AfterStep.MAKE
                }
                AfterStep.MAKE -> onContents()
                AfterStep.DONE -> { AfterRuns.run = null; onContents() }
            }
        }, Modifier.fillMaxWidth().height(96.dp))
    }
}

private fun dayRange(from: Long, to: Long): String {
    val day = SimpleDateFormat("M월 d일", Locale.KOREA); val hm = SimpleDateFormat("HH:mm", Locale.KOREA)
    return if (day.format(Date(from)) == day.format(Date(to))) "${day.format(Date(from))} ${hm.format(Date(from))}–${hm.format(Date(to))}"
    else "${day.format(Date(from))} ${hm.format(Date(from))} – ${day.format(Date(to))} ${hm.format(Date(to))}"
}

/** 왼쪽(내용) + 오른쪽(일행 카드) 두 칸(C22·C31·C32). */
@Composable
private fun Split(trip: Trip, left: @Composable ColumnScope.() -> Unit) {
    val c = MaterialTheme.colorScheme
    Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
        Column(Modifier.weight(.62f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(24.dp), content = left)
        CarCard(modifier = Modifier.weight(.38f).fillMaxHeight(), pad = 32.dp, gap = 20.dp) {
            Text("차가 바뀌어도\n우리는 그대로", fontSize = 40.sp, lineHeight = 50.sp, fontWeight = FontWeight.Bold)
            Text("함께 탄 기록과 콘텐츠를 차량과 폰에서 이어가세요.", fontSize = 26.sp, lineHeight = 36.sp, color = c.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) { trip.people.take(5).forEach { Character(seatCharacter(it), 88.dp) } }
            Text("우리 일행  ${trip.people.size}명", fontSize = 32.sp, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun Summary(title: String, sub: String) {
    val c = MaterialTheme.colorScheme
    Surface(shape = RoundedCornerShape(32.dp), color = c.primaryContainer, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = 28.dp, vertical = 24.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(title, fontSize = 32.sp, lineHeight = 42.sp, fontWeight = FontWeight.Bold)
            if (sub.isNotEmpty()) Text(sub, fontSize = 24.sp, color = c.onSurfaceVariant)
        }
    }
}

@Composable
private fun WaveCard(label: String, bars: List<Float>, filled: Float, seconds: Long) {
    val c = MaterialTheme.colorScheme
    CarCard(pad = 28.dp, gap = 18.dp) {
        Text(label, fontSize = 24.sp)
        Bars(bars, Modifier.fillMaxWidth().height(110.dp)) { i -> if (i < (filled * bars.size).toInt()) c.primary else c.onSurfaceVariant.copy(alpha = .35f) }
        Row(Modifier.fillMaxWidth()) { Text("00:00", fontSize = 24.sp, color = c.onSurfaceVariant); Spacer(Modifier.weight(1f)); Text(afterClock(seconds * 1000), fontSize = 24.sp, color = c.onSurfaceVariant) }
    }
}

@Composable
private fun Bars(bars: List<Float>, modifier: Modifier, color: (Int) -> Color) {
    Canvas(modifier) {
        val step = size.width / bars.size; val w = maxOf(3f, step * .42f)
        bars.forEachIndexed { i, v ->
            val h = maxOf(4f, v * size.height)
            drawRoundRect(color(i), Offset(i * step + (step - w) / 2, (size.height - h) / 2), Size(w, h), CornerRadius(w / 2, w / 2))
        }
    }
}

/** C23–C30 파형: 장면 구간 선과 그 위 번호 표식. 표식을 눌러도 목록과 같은 선택이 바뀐다. */
@Composable
private fun PickWave(label: String, bars: List<Float>, picks: List<AfterPick>, origin: Long, end: Long, chosen: Set<Long>, onToggle: (Long) -> Unit) {
    val c = MaterialTheme.colorScheme
    fun at(t: Long) = if (end > origin) ((t - origin).toFloat() / (end - origin)).coerceIn(0f, 1f) else 0f
    CarCard(pad = 24.dp, gap = 12.dp) {
        Text(label, fontSize = 24.sp, color = c.onSurfaceVariant)
        BoxWithConstraints(Modifier.fillMaxWidth().height(170.dp)) {
            val w = maxWidth
            Bars(bars, Modifier.fillMaxWidth().height(110.dp).align(Alignment.BottomStart)) { c.onSurfaceVariant.copy(alpha = .45f) }
            picks.forEach { p ->
                val on = p.from in chosen
                val x0 = w * at(p.from); val x1 = w * at(p.to)
                Box(Modifier.offset(x = x0).align(Alignment.BottomStart).width(maxOf(6.dp, x1 - x0)).height(110.dp)
                    .background(if (on) c.primary else Color.Transparent)
                    .then(if (on) Modifier else Modifier.background(c.onSurfaceVariant.copy(alpha = .25f))))
                Surface(onClick = { onToggle(p.from) }, shape = RoundedCornerShape(12.dp), color = if (on) c.primary else c.surfaceVariant,
                    modifier = Modifier.offset(x = (x0 + (x1 - x0) / 2 - 28.dp).coerceIn(0.dp, w - 56.dp)).size(56.dp, 48.dp)
                        .semantics { contentDescription = "${p.number}번 장면 ${if (on) "선택 해제" else "선택"}" }) {
                    Box(contentAlignment = Alignment.Center) { Text("${p.number}", fontSize = 24.sp, color = if (on) c.onPrimary else c.onSurface) }
                }
            }
        }
        Row(Modifier.fillMaxWidth()) {
            Text("00:00", fontSize = 24.sp, color = c.onSurfaceVariant); Spacer(Modifier.weight(1f))
            Text(afterAxis((end - origin) / 2), fontSize = 24.sp, color = c.onSurfaceVariant); Spacer(Modifier.weight(1f))
            Text(afterAxis(end - origin), fontSize = 24.sp, color = c.onSurfaceVariant)
        }
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
