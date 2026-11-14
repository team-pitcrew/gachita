package io.github.teampitcrew.gachita

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.compose.ui.res.painterResource
import java.util.Locale
import kotlin.math.pow
import kotlin.math.log10
import kotlin.math.abs
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.Animatable

/*
 * Ride tab of the design 'Y7zFqGUEAFDWTumG30MsOs' (page 2004:57). While recording (paused included) it is the C17 family — C17 2005:3267,
 * C17p 2005:3307, C19 2005:3341, C19p 2014:1046, C21 2005:3404, C21p 2014:1185, resumed 2026:1969, finalNear 2043:1835, finalPaused 2043:1933:
 * the heard lines or the pre-arrival card, '일행 N명' seats, and the recording bar (⏸/●, elapsed time, waveform, ■). Before recording and
 * an ended trip (2026:2410) use the status card layout. The header carries the '내 얼굴' button with the profile menu (2200:5852) and the
 * logout check (2220:5864). Pure functions are covered by DriveTest.
 */

/**
 * Words for the heard card's title (C17 '방금 받아 적은 말 N건' 자리) when the trip is not plainly taking the talk down or paused by the user.
 * The design has no status card, so holds (Gleo, microphone), consent and withdrawal are told here; null = the design's own title.
 */
internal fun driveNote(
    recording: Boolean, muted: Boolean, handoff: Handoff.State, mic: Mic, why: String,
    offPending: Boolean, waiting: Boolean, inPark: Boolean, waitingFor: List<String>, ended: Boolean = false,
): String? = when {
    ended && !offPending -> null
    recording && muted -> null
    recording && handoff != Handoff.State.OFF -> if (handoff == Handoff.State.WAITING) "운전대 버튼을 누르세요" else "Gleo가 끝나면 기록을 이어 가요"
    recording -> when (mic) {
        Mic.ON -> null
        Mic.BLOCKED -> "마이크를 쓸 수 있으면 다시 기록해요"
        Mic.FAILED -> why.ifBlank { "마이크를 열지 못했어요" }
        else -> "마이크를 켜고 있어요"
    }
    offPending -> "원음과 대화를 지우고 있어요"
    waiting -> if (inPark) "모두 동의했어요. 출발하면 자동으로 기록해요" else "곧 자동으로 기록을 시작해요"
    else -> if (waitingFor.isEmpty()) "동승자를 확인해 주세요" else "${waitingFor.joinToString(", ")} · 녹음 동의가 필요해요"
}

/** The recording bar's left button (C17 ⏸ '일시정지', C17p ● '녹화 재개'); OFF = shown but not pressable. */
internal enum class Press { STOP, GO, OFF }

internal data class DriveButton(val label: String, val press: Press, val enabled: Boolean)

/**
 * The recording bar's ⏸/● (its label is the button's accessibility name). Recording starts by itself once the trip turns to driving with
 * everyone's consent (Session.autoStart), and ● starts it by hand then. Without everyone's consent ● stays off — consent is given on each phone.
 */
internal fun driveButton(recording: Boolean, muted: Boolean, agreed: Boolean): DriveButton = when {
    recording && !muted -> DriveButton("일시정지", Press.STOP, true)
    recording || agreed -> DriveButton("녹화 재개", Press.GO, true)
    else -> DriveButton("녹화 재개", Press.OFF, false)
}

/** Seat word for the heard line ('서준 / 뒷좌석'). Only the server seat names are known; anything else is null. */
internal fun seatWord(seat: String?): String? = when {
    seat == Seat.ROW_1_LEFT.name -> "운전석"
    seat == Seat.ROW_1_RIGHT.name -> "조수석"
    seat != null && seat.startsWith("ROW_2_") -> "뒷좌석"
    else -> null
}

/** '{name} / {seat}'. Without a confirmed speaker the row zone (T37) gives 앞좌석/뒷좌석; the seat alone never names a person. */
internal fun heardMeta(name: String?, seat: String?, zone: Int?): String =
    listOfNotNull(name ?: "말한 사람 미확인", seatWord(seat) ?: zone?.let { if (it == 0) "앞좌석" else "뒷좌석" }).joinToString(" / ")

/** Character index used everywhere in the car app: guests have no character value yet, so it follows seat order (Theme.kt). */
internal fun seatCharacter(p: Person): Int = Seat.entries.indexOfFirst { it.name == p.seat }.coerceAtLeast(0)

/** Pre-arrival brief (D20, finalNear 2043:1835): the next place from the navigation and whole minutes left, rounded up. final: no waypoint left. */
internal data class Approach(val trip: String, val place: String, val minutes: Int, val seconds: Int, val final: Boolean = false)

internal const val APPROACH_SECONDS = 300

/** Approaching when the navigation reports 0 < remaining time <= 5 minutes for a named place. 0 means the navigation has no estimate. */
internal fun approach(trip: String, name: String?, remainSeconds: Int?, final: Boolean = false, limit: Int = APPROACH_SECONDS): Approach? {
    val place = name?.trim().orEmpty()
    if (place.isEmpty() || remainSeconds == null || remainSeconds !in 1..limit) return null
    return Approach(trip, place, maxOf(1, (remainSeconds + 59) / 60), remainSeconds, final)
}

/** Open server todos whose place word is in the navigation name, the same rule as the server's arrival match ('마트' in '하나로마트 강릉점'). */
internal fun placeAsks(place: String, items: List<SharedTodo>): List<SharedTodo> = items.filter { it.pending && arrivedAt(it.place, place) }

/** First confirmed speaker of an ask: the server's requestedBy first, else the earliest source with a trip participant. Unknown stays null. */
internal fun askSpeaker(item: SharedTodo, people: List<Person>): Person? =
    item.requestedBy.firstNotNullOfOrNull { id -> people.find { it.id == id } }
        ?: item.sources.sortedBy { it.at }.firstNotNullOfOrNull { s -> people.find { it.id == s.participantId } }

/** '고기와 과일', '삼겹살과 귤', three or more '고기, 과일과 음료' (와/과 by the final consonant). */
internal fun andWords(names: List<String>): String = when (names.size) {
    0 -> ""
    1 -> names[0]
    else -> names.dropLast(1).joinToString(", ") + (if (hasBatchim(names[names.size - 2])) "과 " else "와 ") + names.last()
}

internal fun hasBatchim(word: String): Boolean = word.trim().lastOrNull()?.let { it in '가'..'힣' && (it - '가') % 28 != 0 } ?: false

/**
 * One short phrase per ask (older C19 '하은 화장실 / 고기와 과일 / 간식과 음료'): things to buy as a list of goods, anything else with the
 * confirmed requester's name in front, things to bring end with '챙기기'. Older servers without action items give the ask text.
 */
internal fun nearPhrase(item: SharedTodo, people: List<Person>): String {
    val names = item.items.map { it.name }
    val who = askSpeaker(item, people)?.name
    return when (item.category) {
        "buy" -> andWords(names).ifEmpty { item.title ?: item.text }
        "first", "remember" -> listOfNotNull(who, names.firstOrNull() ?: item.title ?: item.text).joinToString(" ")
        "bring" -> listOfNotNull(who, if (names.isEmpty()) item.title ?: item.text else "${andWords(names)} 챙기기").joinToString(" ")
        else -> item.text
    }
}

internal fun nearLine(asks: List<SharedTodo>, people: List<Person>): String = asks.joinToString(" / ") { nearPhrase(it, people) }

/** Recorded time like the C17 recording bar '19:11' (minutes:seconds); from one hour on '1:02:03'. It counts only while the microphone takes the talk down. */
internal fun recordClock(ms: Long): String = (ms.coerceAtLeast(0) / 1000).let { s ->
    if (s < 3600) String.format(Locale.ROOT, "%02d:%02d", s / 60, s % 60) else String.format(Locale.ROOT, "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
}

/** Levels kept for the waveform (Live.levels): 6 s of 0.1 s chunks, more than the 24 bars left of the cursor. */
internal const val WAVE_BARS = 60

/** Below this the bar is dropped (Voice Memos `minimumDecibelDisplayRange` −72 dB, production/car-port-20261115/voice-memos-waveform.md). */
internal const val WAVE_FLOOR_DB = -72f

/**
 * Level of one 0.1 s chunk the way Voice Memos meters it: the peak of the chunk (largest |sample| of the 16-bit little-endian mono), in
 * dBFS, −120 for digital silence. One value per bar, so no further decimation is needed.
 */
internal fun chunkPeakDb(mono: ByteArray): Float {
    var peak = 0
    var i = 0
    while (i + 1 < mono.size) { peak = maxOf(peak, abs((mono[i].toInt() and 0xFF) or (mono[i + 1].toInt() shl 8))); i += 2 }
    return if (peak == 0) -120f else (20 * log10(peak / 32768.0)).toFloat()
}

/** Bar height (0..1 of half the box) from a peak level: `10^(dB/24)` like Voice Memos (quiet speech stays visible, peaks do not slam), 0 below −72 dB. */
internal fun waveAmp(db: Float): Float = if (db < WAVE_FLOOR_DB) 0f else 10f.pow(db / 24f).coerceIn(0f, 1f)

internal data class NearRow(val icon: BriefIcon, val text: String)

/**
 * C19 rows ('🚻 화장실 가기 / 🛒 장보기 / 🗑 쓰레기 정리하기'): one short action per ask with the design's Twemoji picture (Arrival.kt BriefIcon,
 * res/drawable/ic_brief_*), every thing to buy folded into '장보기', at most three. Anything else keeps the ask's title with the picture
 * the arrival brief gives it (finalNear '🧊 고기 냉장 보관').
 * ponytail: keyword rule on the ask words. A short label from the server replaces it once the rules give one.
 */
internal fun nearRows(asks: List<SharedTodo>): List<NearRow> = asks.map { a ->
    val words = listOfNotNull(a.title, a.text) + a.items.map { it.name }
    fun has(re: String) = words.any { Regex(re).containsMatchIn(it) }
    val title = a.title ?: a.text
    when {
        has("화장실") -> NearRow(BriefIcon.RESTROOM, "화장실 가기")
        a.category == "buy" -> NearRow(BriefIcon.CART, "장보기")
        has("쓰레기") -> NearRow(BriefIcon.TRASH, title) // C19 '쓰레기 정리하기', finalNear '짐과 쓰레기 챙기기'(🗑)
        else -> NearRow(iconOf("$title ${a.items.firstOrNull()?.name.orEmpty()}", a.category), title)
    }
}.distinct().take(3)

/** '나' in the conversation and the profile menu: the driver who joined with a profile (a group trip seats its owner at the wheel, Family.kt). */
internal fun mePerson(people: List<Person>): Person? = people.firstOrNull { it.profile && it.seat == Seat.ROW_1_LEFT.name }


// ---- UI ----

/**
 * Which frame the trip screen uses, by what is on screen, not by the window width: 함께 타는 중 (C17 family, ended) uses [Shell.RIDE],
 * 대화 기록 (C44, liveTranscript) [Shell.TALK], the parked screens (arrival brief C20·D19·finalBrief, the content tab C22–C38) [Shell.PARKED].
 */
internal fun tripShell(parked: Boolean, showsBrief: Boolean, contentTab: Boolean, talk: Boolean = false): Shell = when {
    parked && (showsBrief || contentTab) -> Shell.PARKED
    talk -> Shell.TALK
    else -> Shell.RIDE
}

/** 상위 탭 of 대화 기록 (C44: 80 high, 28 SemiBold/32). 함께 타는 중 (C17) and the parked screens use Car/Label 24 at 76. */
internal val TalkTabText: TextStyle = CarText.Body.copy(fontWeight = FontWeight.SemiBold, lineHeight = 32.sp)
private fun menuText(size: Int, line: Int, weight: FontWeight = FontWeight.Bold) = CarText.Label.copy(fontSize = size.sp, lineHeight = line.sp, fontWeight = weight)

/**
 * 오른쪽 위 '내 얼굴'(11/15 오너 "모든 페이지 우측상단은 프로필 고정, 예외 없음"): 얼굴 그림과 누를 때 할 일. setContent 바닥이 한 번 준다 —
 * 로그인 뒤에는 프로필 메뉴(좁은 창 2200:5852, 주차 1682 폭 2257:5780), 로그인 전에는 기본 캐릭터 얼굴과 '로그인 / 계정 만들기'(C02).
 * [open]은 머리 줄의 틀(메뉴 자리)과 지금 얼굴을 받는다.
 */
class Me(val face: Int, val open: (Shell, Int) -> Unit)

val LocalMe = compositionLocalOf { Me(R.drawable.char_basic) { _, _ -> } }

/**
 * Header row: mascot, '가치타', '주차 중  P' on parked screens, and always the '내 얼굴' button at the right end ([LocalMe], 2200:5920) — every
 * screen draws its header here. The live frames have no connection chip (C17·C44·C20…); a lost connection is told inside the screen.
 */
@Composable
internal fun TripHeader(shell: Shell, listening: Boolean) {
    val c = MaterialTheme.colorScheme
    val park = shell == Shell.PARKED
    Row(Modifier.fillMaxWidth().height(shell.head), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(shell.headGap)) {
        Mascot(listening, 48.dp)
        Text("가치타", style = CarText.Headline, maxLines = 1)
        Spacer(Modifier.weight(1f))
        if (park) Text("주차 중  P", color = c.onSurfaceVariant, style = CarText.Label, maxLines = 1)
        val me = LocalMe.current
        MeButton(me.face) { me.open(shell, me.face) }
    }
}

/** Top tabs (함께 타는 중 / 대화 기록 / 콘텐츠 기록). Disabled tabs keep the same look as the design; they just do not respond. */
@Composable
internal fun TripTabs(
    labels: List<String>, selected: Int, enabled: (Int) -> Boolean, onSelect: (Int) -> Unit, height: Dp = 76.dp, style: TextStyle = CarText.Label,
) {
    val c = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().height(height).clip(CarShape.TabBar).background(c.surfaceVariant).padding(4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        labels.forEachIndexed { i, label ->
            val on = i == selected
            Surface(onClick = { onSelect(i) }, enabled = enabled(i), modifier = Modifier.weight(1f).fillMaxHeight(), shape = CarShape.Tab,
                color = if (on) c.primaryContainer else Color.Transparent) {
                Box(contentAlignment = Alignment.Center) { Text(label, color = if (on) c.onSurface else c.onSurfaceVariant, style = style, maxLines = 1) }
            }
        }
    }
}

// ---- 함께 타는 중 while recording: C17 2005:3267, C17p 2005:3307, C19 2005:3341, C19p 2014:1046, C21·C21p, resumed, finalNear·finalPaused ----

/**
 * C17 body: the middle card (heard lines, the pre-arrival card or a rest-stop offer; 384 in the 841×1210 window, it takes what is left),
 * '일행 N명' seats, and the recording bar at the bottom, 16 apart.
 */
@Composable
internal fun RideLayout(middle: @Composable (Modifier) -> Unit, seats: @Composable () -> Unit, bar: @Composable () -> Unit, modifier: Modifier = Modifier) {
    // 시안 본문 982(가운데 384 · 좌석 418 · 막대 136 · 간격 16 셋). 남는 높이는 아래로(시안도 위 정렬)
    Column(modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        middle(Modifier.fillMaxWidth().weight(1f, fill = false).height(384.dp))
        seats()
        bar()
    }
}

/**
 * '기록 컨트롤 / 상태와 동작' (2014:943, 136 high, corner 32, edge 1): ⏸ (two 6×26 bars, '일시정지') or, when paused, the red record mark
 * ('녹화 재개', 2114:5971), the elapsed time 56 (red #F23424 while taking the talk down, ink otherwise), the waveform (292×84 at x 234) and
 * ■ ('녹화 종료': 68 ring 2, square 24) at the right. [control] is the pause/resume button (its label is the button's accessibility name).
 */
@Composable
internal fun RecordBar(control: DriveButton, live: Boolean, time: String, levels: () -> List<Float>, onControl: () -> Unit, onStop: () -> Unit, modifier: Modifier = Modifier) {
    val c = MaterialTheme.colorScheme
    val paused = control.press != Press.STOP // ● '녹화 재개'(꺼짐이어도 ●)
    // 테두리 1은 기록 중에만(원본 C19·C21·finalNear·resumed·D17·D18·D20). 멈춤 프레임(C17p·C19p·C21p·finalPaused·D*p)에는 없다. 원본 C17만 예외로 없지만 같은 화면의 D17은 있다.
    Box(modifier.fillMaxWidth().height(136.dp).then(if (paused) Modifier else Modifier.border(1.dp, CarRecord.Edge, CarShape.Card))) {
        Row(Modifier.align(Alignment.CenterStart).padding(start = 7.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(68.dp).clickable(enabled = control.enabled, role = Role.Button, onClick = onControl)
                .semantics { contentDescription = control.label }) {
                // 시안 'image 1'(61×77)은 68 칸 밖으로 위아래가 넘친다(자르지 않음): 칸 안 (3.5, −1.5)에. requiredSize가 넘친 만큼 위로 4.5 올려 두므로 3을 더 내린다
                if (paused) Image(painterResource(R.drawable.ic_rec_resume), null, Modifier.offset(3.5.dp, 3.dp).requiredSize(61.dp, 77.dp))
                else listOf(23.dp, 39.dp).forEach { x -> Box(Modifier.offset(x, 21.dp).size(6.dp, 26.dp).clip(RoundedCornerShape(2.dp)).background(c.onSurface)) }
            }
            Text(time, color = if (live) CarRecord.Timer else c.onSurface, style = CarText.Status, maxLines = 1)
        }
        Wave(levels, live, Modifier.align(Alignment.CenterStart).padding(start = 234.dp).size(292.dp, 84.dp))
        Box(Modifier.align(Alignment.CenterEnd).padding(end = 19.dp).size(68.dp).clip(CircleShape).border(2.dp, CarRecord.StopRing, CircleShape)
            .clickable(role = Role.Button, onClick = onStop).semantics { contentDescription = "녹화 종료" }, contentAlignment = Alignment.Center) {
            Box(Modifier.size(24.dp).clip(RoundedCornerShape(3.dp)).background(c.onSurface))
        }
    }
}

/**
 * '녹화 파형' (2196:5878): the C17 picture's look — a 292×84 box on #231D1F, bars 3.5 wide every 6, symmetric about the middle, the cursor
 * at the centre with the recorded bars in ink to its left and dim (45%) ones to its right, tallest 59 (padding 12.5), shortest 4.5 — drawn with
 * the Voice Memos logic (voice-memos-waveform.md): one bar per 0.1 s peak ([chunkPeakDb]), height `10^(dB/24)` dropping below −72 dB,
 * newest at the cursor and scrolling left by one pitch over each 0.1 s, frozen in place while paused. Right of the cursor nothing is
 * recorded yet, so it shows the shortest dim bars. 11/15 owner: the waveform and time move while driving.
 */
@Composable
internal fun Wave(levels: () -> List<Float>, live: Boolean, modifier: Modifier) {
    val c = MaterialTheme.colorScheme
    val now = levels() // 새 조각이 들어올 때마다 한 칸 밀기를 다시 시작한다
    val step = remember { Animatable(1f) }
    LaunchedEffect(now, live) { if (live) { step.snapTo(0f); step.animateTo(1f, tween(100, easing = LinearEasing)) } } // 멈추면 그 자리에 선다
    Canvas(modifier.clipToBounds().background(CarRecord.WaveBg)) {
        val pitch = 6.dp.toPx(); val barW = 3.5.dp.toPx()
        val half = size.height / 2; val maxHalf = half - 12.5.dp.toPx(); val minHalf = 2.25.dp.toPx()
        val cursor = size.width / 2; val shift = step.value * pitch
        for (k in now.indices.reversed()) { // 녹음한 것: 새 것이 커서, 오래된 것이 왼쪽
            val x = cursor - (now.size - 1 - k) * pitch - shift
            if (x < -barW) break
            val h = (waveAmp(now[k]) * half).coerceIn(minHalf, maxHalf)
            drawRect(c.onSurface, Offset(x - barW / 2, half - h), Size(barW, 2 * h))
        }
        var x = cursor + pitch - shift // 아직 녹음하지 않은 오른쪽
        while (x < size.width + barW) { drawRect(c.onSurface.copy(alpha = 0.45f), Offset(x - barW / 2, half - minHalf), Size(barW, 2 * minHalf)); x += pitch }
    }
}

/**
 * '도착 전 브리핑 / C1n 카드' (C19 2014:1079): accent-soft, corner 32, padding 24/16, gap 8 — '기록' (2254:5849, Noto Sans KR Medium 24 accent —
 * the system Korean font), rows 40 Bold ink with the Twemoji 44 at the right, 99·53·87 high and 5 apart, '정차하면 자세히 보여드릴게요' 24 ink-2.
 * The final destination (D補 finalNear) uses this C19 card too — the C frame wins over the D frame. Details come after parking (C20).
 */
@Composable
internal fun NearCard(lines: List<NearRow>, modifier: Modifier) {
    val c = MaterialTheme.colorScheme
    Surface(modifier, CarShape.Card, color = c.primaryContainer, contentColor = c.onSurface) {
        Column(Modifier.padding(horizontal = 24.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("기록", color = c.primary, style = CarText.Label.copy(fontFamily = FontFamily.Default), maxLines = 1)
            Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                lines.forEachIndexed { i, l ->
                    Row(Modifier.fillMaxWidth().height(C19_ROWS.getOrElse(i) { 53 }.dp), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                        Text(l.text, Modifier.weight(1f), style = CarText.Title.copy(letterSpacing = (-0.02).em), maxLines = 1, overflow = TextOverflow.Ellipsis) // 40 Bold, -0.8px
                        Image(painterResource(l.icon.res), null, Modifier.size(44.dp))
                    }
                }
            }
            Text("정차하면 자세히 보여드릴게요", color = c.onSurfaceVariant, style = CarText.Label, maxLines = 1)
        }
    }
}

/** C19 줄 높이(2246:5864·5873·5886) 그대로. */
private val C19_ROWS = listOf(99, 53, 87)

// ---- shared cards ----

/** One heard line: speaker character ([face] picture, else seat-order [character], else an empty circle), '{name} / {seat}', the words. */
internal data class HeardRow(val meta: String, val text: String, val character: Int?, val face: Int? = null)

/**
 * 'heard' card: C17 (2014:948) '방금 받아 적은 말 N건', padding 46 (bottom 16), gap 14, the first line 34 lower. Paused or ended:
 * '멈추기 전 마지막 대화' at 60%. Newest first, two lines, each avatar 48 · '{name} / {seat}' 24
 * ink-2 · the words 28 on one line.
 */
@Composable
internal fun HeardCard(title: String, rows: List<HeardRow>, dim: Boolean, modifier: Modifier) {
    val roomy = true
    val c = MaterialTheme.colorScheme
    Surface(modifier, CarShape.Card, color = c.surface) {
        Column(Modifier.then(if (dim) Modifier.alpha(0.6f) else Modifier)
            .padding(start = if (roomy) 46.dp else 24.dp, end = if (roomy) 46.dp else 24.dp, top = if (roomy) 46.dp else 16.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(if (roomy) 14.dp else 12.dp)) {
            Text(title, style = CarText.Label, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (rows.isEmpty()) Text("아직 받아 적은 말이 없어요", Modifier.padding(top = if (roomy) 34.dp else 0.dp), color = c.onSurfaceVariant, style = CarText.Body)
            rows.take(2).forEachIndexed { i, r ->
                Row(Modifier.padding(top = if (roomy && i == 0) 34.dp else 0.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    when {
                        r.face != null -> CharAvatar(r.face, 48.dp)
                        r.character != null -> Avatar(r.character, 48.dp)
                        else -> Box(Modifier.size(48.dp).clip(CircleShape).background(c.surfaceVariant))
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(if (roomy) 2.dp else 0.dp)) {
                        Text(r.meta, color = c.onSurfaceVariant, style = CarText.Label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(r.text, style = CarText.Body, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}

/**
 * 'seat map' card (C17 2114:5922, ended 2026:2436): '일행 N명' 32 · '차 앞쪽 ▲' 24, the car body (surface-2, corner 40, padding 12, gap 8) with
 * the car's seat rows (padding 8/12): face 80, name 24 (the speaker Bold with the mint ring 2209:5864), an empty seat as a dashed circle at
 * 60% and '빈자리'. Consent waiting is told in the heard card's title, not here (the design has no note under the names).
 */
@Composable
internal fun SeatCard(people: List<Person>, car: CarStatus, speaking: String?) {
    val c = MaterialTheme.colorScheme
    Surface(Modifier.fillMaxWidth(), CarShape.Card, color = c.surface) {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Text("일행 ${people.size}명", Modifier.weight(1f), style = CarText.Headline, maxLines = 1)
                Text("차 앞쪽 ▲", color = c.onSurfaceVariant, style = CarText.Label, maxLines = 1)
            }
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(40.dp)).background(c.surfaceVariant).padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                seatRows(car.seats).forEach { seats ->
                    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 12.dp)) {
                        seats.forEach { seat ->
                            val p = people.firstOrNull { it.seat == seat.name }
                            val talking = p != null && p.id == speaking
                            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Box(Modifier.size(80.dp), contentAlignment = Alignment.Center) {
                                    if (p == null) Box(Modifier.alpha(0.6f)) { EmptySeat(80.dp) } else Avatar(p, 80.dp)
                                    if (talking) SpeakerRing()
                                }
                                Text(
                                    p?.name ?: "빈자리",
                                    color = if (p == null) c.onSurfaceVariant else c.onSurface,
                                    style = CarText.Label.copy(fontWeight = if (talking) FontWeight.Bold else FontWeight.Medium), maxLines = 1, overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * '화자 링 / 민트' (2209:5864, 88 box, circle r41.75 stroke 4.5 with the mint gradient and a soft mint glow) and '안쪽 하이라이트'
 * (2209:5865, r37.4 stroke 1.2) around an 80 face, drawn over it without taking layout room.
 */
@Composable
private fun SpeakerRing() {
    Canvas(Modifier.size(80.dp)) {
        val k = 1.dp.toPx(); val center = Offset(size.width / 2, size.height / 2)
        drawCircle(CarRecord.RingGlow, 41.75f * k, center, style = Stroke(10f * k)) // 그림자 흐림 4를 넓은 옅은 테로
        val brush = Brush.linearGradient(*CarRecord.Ring.toTypedArray(), start = center + Offset(-53.08f * k, -20.64f * k), end = center + Offset(53.08f * k, 20.64f * k))
        drawCircle(brush, 41.75f * k, center, style = Stroke(4.5f * k))
        drawCircle(CarRecord.RingInner, 37.4f * k, center, style = Stroke(1.2f * k))
    }
}

// ---- header '내 얼굴' button, profile menu (2200:5852) and logout check (2220:5864) ----

/** '내 얼굴' button at the right end of the ride header: 64 to press, face 54 (C17 2200:5920). */
@Composable
internal fun MeButton(face: Int, onClick: () -> Unit) {
    Box(Modifier.size(64.dp).clip(CircleShape).clickable(role = Role.Button, onClick = onClick).semantics { contentDescription = "프로필 메뉴 열기" },
        contentAlignment = Alignment.Center) { CharAvatar(face, 54.dp) }
}

/**
 * Profile menu — live 2200:5852 (841 window, top 92 · right 37) and 2257:5780 (1682 window, top 120 · right 45) are the same card: 480 wide,
 * corner 26, border 2 #7A9C87, padding 24/20, gap 12, outside black 56%. Profile row 86 (face 48, name 29/42); the riding group (ok-soft 114:
 * name 30/36 · 👤 count #ADC2B8 · 2×2 faces · ›) → group change; 좌석 배정; 갤러리 바로가기 (#F5F2ED); 로그아웃 (92% white); the note
 * '그룹 변경과 좌석 배정은 주차 후에 이용해 주세요.' last, centred (18/30). Noto Sans KR in the design = the system Korean font.
 * Group change and seats are off while driving. [keepBottom]: the bottom strip the scrim leaves pressable — on the driving window the
 * recording bar's ●/■ still work with the menu open (C17m 2206:5852).
 */
@Composable
internal fun BoxScope.ProfileMenu(
    name: String, face: Int, group: String, people: List<Person>, driving: Boolean, top: Dp, end: Dp,
    onClose: () -> Unit, onGroup: () -> Unit, onSeats: () -> Unit, onGallery: () -> Unit, onLogout: () -> Unit, keepBottom: Dp = 0.dp,
) {
    fun menuText(size: Int, line: Int, weight: FontWeight = FontWeight.Bold): TextStyle =
        CarText.Label.copy(fontSize = size.sp, lineHeight = line.sp, fontWeight = weight, fontFamily = FontFamily.Default)
    val c = MaterialTheme.colorScheme
    Box(Modifier.matchParentSize().background(CarMenu.Scrim)) // 어둡게만(누름은 아래 칸이 받는다)
    Box(Modifier.align(Alignment.TopStart).fillMaxWidth().fillMaxHeight().padding(bottom = keepBottom)
        .clickable(remember { MutableInteractionSource() }, indication = null, onClick = onClose))
    Surface(Modifier.align(Alignment.TopEnd).padding(top = top, end = end).width(480.dp), RoundedCornerShape(26.dp), color = CarMenu.Surface,
        border = BorderStroke(2.dp, CarMenu.Line), shadowElevation = 18.dp) {
        Column(Modifier.padding(horizontal = 24.dp, vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth().height(86.dp), verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    CharAvatar(face, 48.dp)
                    Text(name, style = menuText(29, 42), color = c.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Box(Modifier.size(48.dp).clip(CircleShape).clickable(role = Role.Button, onClick = onClose).semantics { contentDescription = "닫기" },
                    contentAlignment = Alignment.Center) { Canvas(Modifier.size(16.dp)) { cross(c.onSurface) } }
            }
            Surface(onClick = onGroup, enabled = !driving, modifier = Modifier.fillMaxWidth().height(114.dp), shape = RoundedCornerShape(18.dp), color = c.tertiaryContainer) {
                Row(Modifier.padding(horizontal = 18.dp), verticalAlignment = Alignment.CenterVertically) {
                    Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(group, Modifier.weight(1f, fill = false), style = menuText(30, 36), color = c.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            Image(painterResource(R.drawable.ic_menu_person), null, Modifier.size(20.dp))
                            Text("${people.size}", style = menuText(19, 26, FontWeight.Medium), color = CarMenu.CountWide, maxLines = 1)
                        }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        FaceGrid(people)
                        Canvas(Modifier.size(20.dp, 28.dp)) { chevron(c.onSurface) }
                    }
                }
            }
            MenuRow("좌석 배정", c.onSurface, !driving, onSeats)
            MenuRow("갤러리 바로가기", CarMenu.InkWide, !driving, onGallery)
            Surface(onClick = onLogout, modifier = Modifier.fillMaxWidth().height(60.dp), shape = RoundedCornerShape(16.dp), color = Color.Transparent) {
                Box(Modifier.padding(horizontal = 18.dp), contentAlignment = Alignment.CenterStart) {
                    Text("로그아웃", style = menuText(24, 34), color = Color.White.copy(alpha = 0.92f), maxLines = 1)
                }
            }
            Text("그룹 변경과 좌석 배정은 주차 후에 이용해 주세요.", Modifier.fillMaxWidth().height(47.dp).wrapContentHeight(), color = c.onSurfaceVariant,
                style = menuText(18, 30, FontWeight.Normal), textAlign = TextAlign.Center)
        }
    }
}

/** Logout check (2220:5866): 480×232 in the middle, padding 24, gap 14, outside black 62% cancels; 취소 and 로그아웃 208×68, corner 16. */
@Composable
internal fun BoxScope.LogoutConfirm(onCancel: () -> Unit, onLogout: () -> Unit) {
    Scrim(CarMenu.ConfirmScrim, onCancel)
    Surface(Modifier.align(Alignment.Center).size(480.dp, 232.dp), RoundedCornerShape(26.dp), color = CarMenu.Surface, border = BorderStroke(2.dp, CarMenu.Line),
        shadowElevation = 18.dp) {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("로그아웃할까요?", style = menuText(30, 42), color = CarMenu.Ink, maxLines = 1)
            Text("로그아웃하면 시작 화면으로 돌아가요.", style = menuText(21, 30, FontWeight.Normal), color = CarMenu.Ink2, maxLines = 1)
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Surface(onClick = onCancel, modifier = Modifier.weight(1f).height(68.dp), shape = RoundedCornerShape(16.dp), color = CarMenu.Cancel) {
                    Box(contentAlignment = Alignment.Center) { Text("취소", style = menuText(24, 36), color = CarMenu.Ink, maxLines = 1) }
                }
                Surface(onClick = onLogout, modifier = Modifier.weight(1f).height(68.dp), shape = RoundedCornerShape(16.dp), color = CarMenu.Confirm) {
                    Box(contentAlignment = Alignment.Center) { Text("로그아웃", style = menuText(24, 36), color = CarMenu.ConfirmInk, maxLines = 1) }
                }
            }
        }
    }
}

/** Dims the screen behind the menu or the check; pressing it cancels. */
@Composable
private fun BoxScope.Scrim(color: Color, onClick: () -> Unit) {
    Box(Modifier.matchParentSize().background(color).clickable(remember { MutableInteractionSource() }, indication = null, onClick = onClick))
}

/** Menu row (2257:5852·5857): 66 high, corner 16, padding 18, surface-2, text 25/36 Bold, '›' 20×28 at the right. Off while driving. */
@Composable
private fun MenuRow(label: String, ink: Color, enabled: Boolean, onClick: () -> Unit) {
    val c = MaterialTheme.colorScheme
    Surface(onClick = onClick, enabled = enabled, modifier = Modifier.fillMaxWidth().height(66.dp), shape = RoundedCornerShape(16.dp), color = c.surfaceVariant) {
        Row(Modifier.padding(horizontal = 18.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(label, Modifier.weight(1f), style = menuText(25, 36).copy(fontFamily = FontFamily.Default), color = ink, maxLines = 1)
            Canvas(Modifier.size(20.dp, 28.dp)) { chevron(c.onSurface) }
        }
    }
}

/** Group faces 2×2 (32 each, 4 apart, 78×74; '동승 그룹 프로필' 2200:5866). */
@Composable
private fun FaceGrid(people: List<Person>) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        people.take(4).chunked(2).forEach { row -> Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) { row.forEach { Avatar(it, 32.dp) } } }
    }
}

/** '닫기' (2200:5859): two 20×2.5 bars crossed. */
private fun DrawScope.cross(color: Color) {
    val w = 2.5.dp.toPx()
    drawLine(color, Offset(0f, 0f), Offset(size.width, size.height), w, StrokeCap.Round)
    drawLine(color, Offset(size.width, 0f), Offset(0f, size.height), w, StrokeCap.Round)
}

/** '이동 화살표' (2200:5873): two 12×2.5 bars meeting at the right, in a 20×28 box. */
private fun DrawScope.chevron(color: Color) {
    val w = 2.5.dp.toPx(); val x = 6.dp.toPx(); val y = size.height / 2; val d = 6.dp.toPx()
    drawLine(color, Offset(x, y - d), Offset(x + d, y), w, StrokeCap.Round)
    drawLine(color, Offset(x + d, y), Offset(x, y + d), w, StrokeCap.Round)
}
