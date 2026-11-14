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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.compose.ui.res.painterResource
import java.util.Locale

/*
 * Ride tab of the design 'Y7zFqGUEAFDWTumG30MsOs' (page 2004:57). While recording (paused included) it is option A '파형 중심' that the owner
 * chose (section 2107:6979): D17 recording 2107:5597, D18 paused 2107:5715, D19 resumed 2107:5834, D20 before arrival 2107:5952, D20p
 * 2112:5678 — timer, waveform, 2×2 seats with the speaker ring, the last heard line, one big control. Before recording and an ended trip
 * (2026:2410) keep the C17 cards. The ride header carries the '내 얼굴' button with the profile menu (2200:5852) and the logout check
 * (2220:5864). Pure functions are covered by DriveTest.
 */

/** Background of the status card: recording (red tint), paused or blocked (amber tint), anything else (plain). */
internal enum class Hero { REC, PAUSED, PLAIN }

internal data class DriveStatus(val title: String, val sub: String, val hero: Hero)

/**
 * Status text for the current recording state. Mirrors the old StatusHero order, with the design's '기록' wording.
 * ended: the trip's server status is 'ended' (2026:2410). resumed: recording came back from a pause and nothing new was heard yet (2026:1969).
 * Option A shows only the timer for REC and the user's pause; the sub line appears there for the other holds (Gleo, shorts, microphone).
 */
internal fun driveStatus(
    recording: Boolean, muted: Boolean, playingShort: Boolean, handoff: Handoff.State, mic: Mic, why: String,
    offPending: Boolean, waiting: Boolean, inPark: Boolean, waitingFor: List<String>, ended: Boolean = false, resumed: Boolean = false,
): DriveStatus = when {
    ended && !offPending -> DriveStatus("여행 기록 완료", "오늘의 대화를 오래 간직해 보세요", Hero.PAUSED)
    recording && muted -> DriveStatus("기록 멈춤", "같은 버튼을 누르면 다시 기록해요", Hero.PAUSED)
    recording && playingShort -> DriveStatus("기록 잠시 멈춤", "쇼츠를 듣는 동안은 기록하지 않아요", Hero.PAUSED)
    recording && handoff != Handoff.State.OFF ->
        DriveStatus("기록 잠시 멈춤", if (handoff == Handoff.State.WAITING) "운전대 버튼을 누르세요" else "Gleo가 끝나면 기록을 이어 가요", Hero.PAUSED)
    recording -> when (mic) {
        Mic.ON -> DriveStatus("기록 중", if (resumed) "중지한 지점부터 이어서 기록해요" else "아래 버튼으로 언제든 멈출 수 있어요", Hero.REC)
        Mic.BLOCKED -> DriveStatus("기록 잠시 멈춤", "마이크를 쓸 수 있으면 다시 기록해요", Hero.PAUSED)
        Mic.FAILED -> DriveStatus("기록 못 함", why.ifBlank { "마이크를 열지 못했어요" }, Hero.PAUSED)
        else -> DriveStatus("기록 준비 중", "마이크를 켜고 있어요", Hero.PLAIN)
    }
    offPending -> DriveStatus("동의 철회", "원음과 대화를 지우고 있어요", Hero.PLAIN)
    waiting -> DriveStatus("기록 준비됨", if (inPark) "모두 동의했어요. 출발하면 자동으로 기록해요" else "곧 자동으로 기록을 시작해요", Hero.PLAIN)
    else -> DriveStatus("동의 대기", if (waitingFor.isEmpty()) "동승자를 확인해 주세요" else "${waitingFor.joinToString(", ")} · 녹음 동의가 필요해요", Hero.PLAIN)
}

/** Look of the full-width bottom button: stop (option A: ink, C17 cards: red tint), go (accent), off (disabled). */
internal enum class Press { STOP, GO, OFF }

internal data class DriveButton(val label: String, val press: Press, val enabled: Boolean)

/**
 * The one big control (A control/live '일시정지', control/paused '계속 기록', ended '새 여행 시작'). Recording starts by itself once the trip
 * turns to driving with everyone's consent (Session.autoStart, C03·C13), so there is no start button: before that the button only says so.
 * Pause and resume keep consent; without consent it opens passenger setup while parked. An ended trip never records again; a new trip is
 * started while parked.
 */
internal fun driveButton(recording: Boolean, muted: Boolean, agreed: Boolean, restricted: Boolean, ended: Boolean = false): DriveButton = when {
    ended && restricted -> DriveButton("주차한 뒤 새 여행을 시작해요", Press.OFF, false)
    ended -> DriveButton("새 여행 시작", Press.GO, true)
    recording && !muted -> DriveButton("일시정지", Press.STOP, true)
    recording -> DriveButton("계속 기록", Press.GO, true)
    agreed -> DriveButton("출발하면 자동으로 기록해요", Press.OFF, false)
    restricted -> DriveButton("주차한 뒤 동의할 수 있어요", Press.OFF, false)
    else -> DriveButton("동승자 설정", Press.GO, true)
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

/** Recorded time as option A shows it ('00:12:48', hours:minutes:seconds). It counts only while the microphone takes the talk down. */
internal fun recordClock(ms: Long): String = (ms.coerceAtLeast(0) / 1000).let { s -> String.format(Locale.ROOT, "%02d:%02d:%02d", s / 3600, s / 60 % 60, s % 60) }

/** Bars of the waveform: 6 s of 0.1 s chunk levels. */
internal const val WAVE_BARS = 60

/**
 * The [n] bar heights (0..1) of a scrolling recorder waveform, oldest left and newest right: each bar is one 0.1 s chunk's level
 * (Live.levels, RMS on meterLevel's dB scale), the way AudioRecordView and compose-audiowaveform draw one spike per amplitude and
 * Apple Voice Memos scrolls its live bars. Slots older than the captured history are 0 (drawn at the minimum height).
 */
internal fun waveBars(levels: List<Float>, n: Int = WAVE_BARS): List<Float> = List(n) { i -> levels.getOrNull(levels.size - n + i)?.coerceIn(0f, 1f) ?: 0f }

internal data class NearRow(val icon: BriefIcon, val text: String)

/**
 * D20 rows ('🚻 화장실 가기 / 🛒 장보기 / 🗑 쓰레기 정리하기'): one short action per ask with the design's Twemoji picture (Arrival.kt BriefIcon,
 * res/drawable/ic_brief_*), every thing to buy folded into '장보기', at most three. Anything else keeps the ask's title with the picture
 * the arrival brief gives it (finalNear '🧊 고기는 바로 냉장 보관').
 * ponytail: keyword rule on the ask words. A short label from the server replaces it once the rules give one.
 */
internal fun nearRows(asks: List<SharedTodo>): List<NearRow> = asks.map { a ->
    val words = listOfNotNull(a.title, a.text) + a.items.map { it.name }
    fun has(re: String) = words.any { Regex(re).containsMatchIn(it) }
    val title = a.title ?: a.text
    when {
        has("화장실") -> NearRow(BriefIcon.RESTROOM, "화장실 가기")
        a.category == "buy" -> NearRow(BriefIcon.CART, "장보기")
        has("쓰레기") -> NearRow(BriefIcon.TRASH, "쓰레기 정리하기")
        else -> NearRow(iconOf("$title ${a.items.firstOrNull()?.name.orEmpty()}", a.category), title)
    }
}.distinct().take(3)

/** Seats drawn in the 2×2 grid: every seat except an empty middle one, so a five-seat car with four people still reads 2×2. */
internal fun gridSeats(rows: List<List<Seat>>, people: List<Person>): List<List<Seat>> =
    rows.map { r -> r.filter { s -> !s.name.endsWith("_CENTER") || people.any { it.seat == s.name } } }.filter { it.isNotEmpty() }

/** '나' in the conversation and the profile menu: the driver who joined with a profile (a group trip seats its owner at the wheel, Family.kt). */
internal fun mePerson(people: List<Person>): Person? = people.firstOrNull { it.profile && it.seat == Seat.ROW_1_LEFT.name }


// ---- UI ----

/**
 * Which frame the trip screen uses. The design has two, chosen by what is on screen, not by the window width: the ride and conversation
 * tabs (A D17–D20, C44, liveTranscript, ended) use [Shell.RIDE] with the '● 연결됨' chip; the parked screens (arrival brief C20·D19·finalBrief,
 * the content tab C22–C38) use [Shell.PARKED] with '주차 중  P'.
 */
internal fun tripShell(parked: Boolean, showsBrief: Boolean, contentTab: Boolean): Shell = if (parked && (showsBrief || contentTab)) Shell.PARKED else Shell.RIDE

// Text sizes of option A·C44·C17m that are not one of the five car steps (the design's own values).
private val semi = FontWeight.SemiBold
/** 상위 탭 of the ride shell (A·C44: 80 high, 28 SemiBold, line 1.25). The parked shell keeps Car/Label 24 at 76 (C22). */
internal val RideTabText: TextStyle = CarText.Body.copy(fontWeight = semi, lineHeight = 35.sp)
private val Timer72 = CarText.Status.copy(fontSize = 72.sp, lineHeight = 90.sp, fontWeight = semi) // 2107:5622, -2%
private val Medium28 = CarText.Body.copy(lineHeight = 35.sp) // '차량 앞쪽 ↑', '서준', '녹음', '00:38:14'
private val Name32 = CarText.Headline.copy(fontWeight = semi, lineHeight = 40.sp, letterSpacing = 0.sp) // 좌석 이름, '약 3분 후 도착'
private val Line40 = CarText.Title.copy(fontWeight = semi, letterSpacing = (-0.01).em) // 마지막 말, 단추 글(-0.4px)
private val Place56 = CarText.Status.copy(fontWeight = semi, lineHeight = 70.sp) // '하나로마트'
private val Row44 = CarText.Title.copy(fontSize = 44.sp, lineHeight = 55.sp, fontWeight = semi) // '화장실 가기'(-0.88px)
private fun menuText(size: Int, line: Int, weight: FontWeight = FontWeight.Bold) = CarText.Label.copy(fontSize = size.sp, lineHeight = line.sp, fontWeight = weight)

/**
 * Header row (A·C44: mascot, '가치타', '● 연결됨'; C22: '주차 중  P'), and on the ride shell the '내 얼굴' button at the right end ([me], C17 2200:5920,
 * opening the profile menu C17m).
 */
@Composable
internal fun TripHeader(shell: Shell, gear: String?, online: Boolean, listening: Boolean, me: (@Composable () -> Unit)? = null) {
    val c = MaterialTheme.colorScheme
    val park = shell == Shell.PARKED
    Row(Modifier.fillMaxWidth().height(shell.head), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(shell.headGap)) {
        Mascot(listening, 48.dp)
        Text("가치타", style = CarText.Headline, maxLines = 1)
        Spacer(Modifier.weight(1f))
        if (!online) Pill("연결 대기", ok = false) else if (!park) Pill("연결됨")
        if (park) Text(if (gear == "P") "주차 중  P" else "정차 중", color = c.onSurfaceVariant, style = CarText.Label, maxLines = 1)
        me?.invoke()
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

// ---- option A: recording window (2107:5597·5715·5834·5952, 2112:5678) ----

/** Last heard line: who ('서준', or '말한 사람 미확인 / 뒷좌석' when nobody is confirmed) and the words. */
internal data class LastLine(val who: String, val text: String)

/**
 * Option A body. [status] decides the look: REC = red dot, timer (72, ink) and the captured waveform; the user's pause = grey dot, flat line,
 * '마지막 대화' in ink-2; other holds (Gleo, shorts, microphone) and a pending [note] put their line where the wave was. [near] swaps the
 * timer block for the D20 brief ('● 녹음 … 00:38:14', place, '약 N분 후 도착', rows).
 */
@Composable
internal fun RecordView(
    status: DriveStatus, paused: Boolean, note: String, time: String, wave: () -> List<Float>,
    people: List<Person>, seats: List<List<Seat>>, occupied: Set<String>, speaking: String?, consentNote: (Person) -> Pair<String, Color>?,
    last: LastLine?, near: Pair<Approach, List<NearRow>>?, control: DriveButton, onControl: () -> Unit, modifier: Modifier = Modifier,
) {
    val c = MaterialTheme.colorScheme
    val live = status.hero == Hero.REC && !paused
    val dot = if (live) c.error else c.onSurfaceVariant // 시안 Ellipse 31d7e #FF8A80, f5160 #B5ADA2
    val word = note.ifBlank { null } ?: status.sub.takeUnless { live || paused }
    BoxWithConstraints(modifier) {
        // 시안 841×1210 창의 본문은 954(시계 묶음 246·좌석 355·마지막 말 95(두 줄이면 145)·간격 24 둘 + 단추 128·간격 24).
        // 낮은 창에서는 시안의 wave/live/medium(96)·small(42)로 줄이고, 마지막 말은 한 줄, 도착 전 줄은 둘로
        val waveH = when { maxHeight >= 896.dp -> 140.dp; maxHeight >= 852.dp -> 96.dp; else -> 42.dp }
        val lastLines = if (maxHeight >= 946.dp) 2 else 1
        val nearRows = if (maxHeight >= 933.dp) 3 else 2
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            Column(Modifier.weight(1f).fillMaxWidth().clipToBounds(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(24.dp)) {
                if (near == null) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                            Canvas(Modifier.size(12.dp)) { drawCircle(dot) }
                            // 1초에 한 번 글자만 바뀐다
                            Text(time, Modifier.width(340.dp), color = c.onSurface, style = Timer72, textAlign = TextAlign.Center, maxLines = 1)
                        }
                        Box(Modifier.widthIn(max = 720.dp).fillMaxWidth().height(waveH), contentAlignment = Alignment.Center) {
                            if (word != null) Text(word, color = if (note.isNotBlank()) c.onSurfaceVariant else c.secondary, style = CarText.Body,
                                textAlign = TextAlign.Center, maxLines = if (waveH > 42.dp) 2 else 1, overflow = TextOverflow.Ellipsis)
                            else Wave(wave, live, Modifier.fillMaxSize())
                        }
                    }
                } else {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Canvas(Modifier.size(12.dp)) { drawCircle(dot) }
                            Text(note.ifBlank { when { live -> "녹음"; paused -> "마이크 꺼짐"; else -> status.title } }, color = c.onSurfaceVariant, style = Medium28,
                                maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        Text(time, Modifier.width(150.dp), color = c.onSurfaceVariant, style = Medium28, maxLines = 1)
                    }
                    NearCard(near.first, near.second.take(nearRows), Modifier.fillMaxWidth())
                }
                SeatGrid(people, seats, occupied, speaking.takeIf { live }, consentNote)
                if (near == null) LastHeard(last, paused, lastLines)
            }
            RecordControl(control, onControl)
        }
    }
}

/**
 * wave/live (2107:5463): 60 red bars 5 wide, corner 3, one per 0.1 s chunk (newest right, at least 8), redrawn on every chunk so the bars
 * scroll left as the car hears (waveBars). wave/paused (2107:5524): 60 bars 6 high in the line colour.
 * [levels] is read while drawing, so a new chunk only redraws this canvas. ponytail: steps once per 0.1 s chunk; no in-between scroll animation (AudioRecordView's soft transition) — add it only if the step looks jerky.
 */
@Composable
internal fun Wave(levels: () -> List<Float>, live: Boolean, modifier: Modifier) {
    val c = MaterialTheme.colorScheme
    Canvas(modifier) {
        val bars = waveBars(levels()) // 그리는 단계에서 읽어 0.1초마다 이 칸만 다시 그린다(화면 전체를 다시 구성하지 않음)
        val w = 5.dp.toPx()
        val gap = (size.width - w * WAVE_BARS) / (WAVE_BARS - 1)
        for (i in 0 until WAVE_BARS) {
            val h = if (live) maxOf(8.dp.toPx(), bars[i] * size.height) else 6.dp.toPx()
            drawRoundRect(if (live) c.error else c.outlineVariant, Offset(i * (w + gap), (size.height - h) / 2), Size(w, h), CornerRadius(3.dp.toPx()))
        }
    }
}

/**
 * D20 '도착 전 핵심 할 일' (2107:5979): place 56, '약 N분 후 도착' 32 accent (gap 8), then rows 44 with the Twemoji picture in a 56 column (gap 20).
 * Option A draws it in place of the timer block; before recording the C17 cards put it in the middle slot.
 */
@Composable
internal fun NearCard(a: Approach, lines: List<NearRow>, modifier: Modifier) {
    val c = MaterialTheme.colorScheme
    Column(modifier, verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(a.place, style = Place56, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("약 ${a.minutes}분 후 도착", color = c.primary, style = Name32, maxLines = 1)
        }
        lines.forEach { l ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                Box(Modifier.width(56.dp), contentAlignment = Alignment.CenterStart) { Image(painterResource(l.icon.res), null, Modifier.size(48.dp)) } // 이모지 44 글자 크기
                Text(l.text, style = Row44, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/**
 * '차량 앞쪽 ↑' and the seats, two per row (560 wide, 240 per seat, gap 12). The speaker's 96 ring gets accent-soft and a 5 accent border,
 * the face 84 and the name 32 in accent (2107:5698). Consent notes appear only for people who have not consented yet.
 */
@Composable
private fun SeatGrid(people: List<Person>, rows: List<List<Seat>>, occupied: Set<String>, speaking: String?, consentNote: (Person) -> Pair<String, Color>?) {
    val c = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("차량 앞쪽 ↑", color = c.onSurfaceVariant, style = Medium28, maxLines = 1)
        rows.forEach { seats ->
            val two = seats.size <= 2
            Row(Modifier.then(if (two) Modifier.widthIn(max = 560.dp) else Modifier).fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                seats.forEach { seat ->
                    val p = people.firstOrNull { it.seat == seat.name }
                    val talking = p != null && p.id == speaking
                    Column(if (two) Modifier.width(240.dp) else Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Box(Modifier.size(96.dp).clip(CircleShape).then(if (talking) Modifier.background(c.primaryContainer).border(5.dp, c.primary, CircleShape) else Modifier),
                            contentAlignment = Alignment.Center) {
                            if (p != null) Avatar(p, 84.dp) else Box(Modifier.alpha(0.6f)) { EmptySeat(84.dp) }
                        }
                        Text(when { p == null -> if (seat.name in occupied) "앉아 있어요" else "빈자리"; else -> p.name },
                            color = when { p == null -> c.onSurfaceVariant; talking -> c.primary; else -> c.onSurface }, style = Name32, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        p?.let(consentNote)?.let { (text, color) -> Text(text, color = color, style = CarText.Label, maxLines = 1) }
                    }
                }
            }
        }
    }
}

/** '마지막으로 들은 말' (2107:5705): '서준' 28 ink-2, gap 10, the words 40 ink; paused (2107:5824) '마지막 대화' and the words in ink-2. */
@Composable
private fun LastHeard(last: LastLine?, paused: Boolean, lines: Int) {
    val c = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(if (paused) "마지막 대화" else last?.who.orEmpty(), color = c.onSurfaceVariant, style = Medium28, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(last?.text ?: "아직 받아 적은 말이 없어요", color = if (paused || last == null) c.onSurfaceVariant else c.onSurface, style = Line40,
            maxLines = lines, overflow = TextOverflow.Ellipsis)
    }
}

/** control/live '⏸ 일시정지' (ink, 2107:5585) and control/paused '▶ 계속 기록' (accent, 2107:5589): 128 high, corner 28, icon 32, gap 20, text 40 in bg. */
@Composable
internal fun RecordControl(b: DriveButton, onClick: () -> Unit) {
    val c = MaterialTheme.colorScheme
    val bg = when (b.press) { Press.STOP -> c.onSurface; Press.GO -> c.primary; Press.OFF -> c.surfaceVariant }
    Surface(onClick = onClick, enabled = b.enabled, modifier = Modifier.fillMaxWidth().height(128.dp), shape = RoundedCornerShape(28.dp), color = bg) {
        Row(horizontalArrangement = Arrangement.spacedBy(20.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
            if (b.press != Press.OFF) Image(painterResource(if (b.press == Press.GO) R.drawable.ic_rec_play else R.drawable.ic_rec_pause), null, Modifier.size(32.dp))
            Text(b.label, Modifier.width(200.dp), color = if (b.press == Press.OFF) c.onSurfaceVariant else c.background, style = Line40, textAlign = TextAlign.Center, maxLines = 1)
        }
    }
}

// ---- C17 cards: before recording, ended trip (2026:2410), rest-stop offer ----

/**
 * Slot layout (ended 2026:2410): status card, middle card (takes the remaining height), seat card, big button 132.
 * Below 860dp of body height the seat card turns into one line and the button gets shorter, so the middle card keeps room.
 */
@Composable
internal fun DriveLayout(
    status: @Composable () -> Unit, middle: @Composable (Modifier) -> Unit, seats: @Composable (compact: Boolean) -> Unit,
    button: DriveButton, onButton: () -> Unit, modifier: Modifier = Modifier,
) {
    BoxWithConstraints(modifier) {
        val compact = maxHeight < 860.dp
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            status()
            middle(Modifier.weight(1f).fillMaxWidth())
            seats(compact)
            BigButton(button, onButton, Modifier.fillMaxWidth().height(if (compact) 96.dp else 132.dp))
        }
    }
}

@Composable
internal fun BigButton(b: DriveButton, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = MaterialTheme.colorScheme
    val (bg, fg) = when (b.press) { Press.STOP -> c.errorContainer to c.error; Press.GO -> c.primary to c.onPrimary; Press.OFF -> c.surfaceVariant to c.onSurfaceVariant }
    Surface(onClick = onClick, enabled = b.enabled, modifier = modifier, shape = CarShape.Ctl, color = bg) {
        Box(contentAlignment = Alignment.Center) { Text(b.label, color = fg, style = CarText.Headline, maxLines = 1) }
    }
}

/** Small pill-shaped action inside a card. 56dp tall, Car/Label 24. */
@Composable
internal fun CardAction(label: String, color: Color = MaterialTheme.colorScheme.primary, onClick: () -> Unit) {
    OutlinedButton(onClick, Modifier.heightIn(min = 56.dp), shape = CarShape.Ctl, border = BorderStroke(2.dp, color.copy(alpha = 0.5f)),
        contentPadding = PaddingValues(horizontal = 18.dp)) { Text(label, color = color, style = CarText.Label, maxLines = 1) }
}

/** Status hero (ended 2026:2419, 140 high, padding 28/20, gap 4): '● 여행 기록 완료' 56 with the sub line 24. A pending note replaces the sub line. */
@Composable
internal fun StatusCard(status: DriveStatus, note: String, actions: @Composable RowScope.() -> Unit = {}) {
    val c = MaterialTheme.colorScheme
    val (bg, fg) = when (status.hero) { Hero.REC -> c.errorContainer to c.error; Hero.PAUSED -> c.secondaryContainer to c.secondary; Hero.PLAIN -> c.surface to c.onSurface }
    Surface(Modifier.fillMaxWidth().heightIn(min = 140.dp), CarShape.Card, color = bg) {
        Column(Modifier.padding(horizontal = 28.dp, vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                if (status.hero != Hero.PLAIN) Canvas(Modifier.size(24.dp)) { drawCircle(fg) }
                Text(status.title, Modifier.weight(1f), color = fg, style = if (status.title.length <= 7) CarText.Status else CarText.Title,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                actions()
            }
            Text(note.ifBlank { status.sub }, color = c.onSurfaceVariant, style = CarText.Label, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** One heard line: speaker character ([face] picture, else seat-order [character], else an empty circle), '{name} / {seat}', the words. */
internal data class HeardRow(val meta: String, val text: String, val character: Int?, val face: Int? = null)

/**
 * ended '멈추기 전 마지막 대화' (dimmed, 2026:2424) and the pre-recording '방금 받아 적은 말 N건'. Newest first, no auto scroll. Each row is the
 * speaker's round avatar 48, '{name} / {seat}' and the sentence. When the newest sentence wraps the older row is left out instead of being cut off.
 */
@Composable
internal fun HeardCard(title: String, rows: List<HeardRow>, dim: Boolean, modifier: Modifier) {
    val c = MaterialTheme.colorScheme
    var newestWraps by remember(rows.firstOrNull()?.text) { mutableStateOf(false) }
    Surface(modifier, CarShape.Card, color = c.surface) {
        Column(Modifier.padding(horizontal = 24.dp, vertical = 16.dp).then(if (dim) Modifier.alpha(0.6f) else Modifier), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(title, style = CarText.Label, maxLines = 1)
            if (rows.isEmpty()) Text("아직 받아 적은 말이 없어요", color = c.onSurfaceVariant, style = CarText.Body)
            rows.take(if (newestWraps) 1 else 2).forEachIndexed { i, r ->
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    when {
                        r.face != null -> CharAvatar(r.face, 48.dp)
                        r.character != null -> Avatar(r.character, 48.dp)
                        else -> Box(Modifier.size(48.dp).clip(CircleShape).background(c.surfaceVariant))
                    }
                    Column(Modifier.weight(1f)) {
                        Text(r.meta, color = c.onSurfaceVariant, style = CarText.Label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(r.text, style = CarText.Body, maxLines = if (i == 0) 2 else 1, overflow = TextOverflow.Ellipsis,
                            onTextLayout = { if (i == 0) newestWraps = it.lineCount > 1 })
                    }
                }
            }
        }
    }
}

/**
 * Seat map card (ended 2026:2436, '일행 N명' · '차 앞쪽 ▲'). Rows and seats come from the car's seat areas (seatRows). The speaking person
 * gets a ring and their row (or the heard row zone, T37) the accent background. Consent notes appear only for people who have not consented
 * yet. compact = one line for short windows.
 */
@Composable
internal fun SeatCard(people: List<Person>, car: CarStatus, speaking: String?, zone: Int?, compact: Boolean, note: (Person) -> Pair<String, Color>?) {
    val c = MaterialTheme.colorScheme
    Surface(Modifier.fillMaxWidth(), CarShape.Card, color = c.surface) {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Text("일행 ${people.size}명", Modifier.weight(1f), style = CarText.Headline, maxLines = 1)
                if (!compact) Text("차 앞쪽 ▲", color = c.onSurfaceVariant, style = CarText.Label, maxLines = 1)
            }
            if (compact) {
                val who = people.find { it.id == speaking }
                Text(people.joinToString(" · ") { if (it == who) "${it.name}(말하는 중)" else it.name }, color = c.onSurfaceVariant, style = CarText.Label,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                return@Column
            }
            val rows = seatRows(car.seats)
            val speakingRow = zone ?: people.find { it.id == speaking }?.let { p -> rows.indexOfFirst { r -> r.any { it.name == p.seat } } }?.takeIf { it >= 0 }
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(40.dp)).background(c.surfaceVariant).padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                rows.forEachIndexed { i, seats ->
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(28.dp)).then(if (i == speakingRow) Modifier.background(c.primaryContainer) else Modifier)
                        .padding(horizontal = 8.dp, vertical = 12.dp)) {
                        seats.forEach { seat ->
                            val p = people.firstOrNull { it.seat == seat.name }
                            val talking = p != null && p.id == speaking
                            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                if (p == null) Box(Modifier.alpha(0.6f)) { EmptySeat(80.dp) } else Avatar(p, 80.dp, ring = talking)
                                Text(
                                    when { p == null -> if (seat.name in car.occupied) "앉아 있어요" else "빈자리"; else -> p.name },
                                    color = if (p == null) c.onSurfaceVariant else c.onSurface,
                                    style = CarText.Label.copy(fontWeight = if (talking) FontWeight.Bold else FontWeight.Medium), maxLines = 1, overflow = TextOverflow.Ellipsis,
                                )
                                p?.let(note)?.let { (text, color) -> Text(text, color = color, style = CarText.Label, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                            }
                        }
                    }
                }
            }
        }
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
 * Profile menu (2200:5854): 480 wide at the top right, corner 26, border 2, padding 24/20, gap 12, outside black 56%. Face 48 and name 29 with
 * 닫기; the current riding group (ok-soft 106: '현재 동승 그룹' 19, name 25, 👤 count, 2×2 faces, ›) that opens the group change; 좌석 배정;
 * 🖼 갤러리 바로가기; while driving the note '그룹 변경과 좌석 배정은 주차 후에 이용해 주세요.' with those blocked; 로그아웃.
 */
@Composable
internal fun BoxScope.ProfileMenu(
    name: String, face: Int, group: String, people: List<Person>, driving: Boolean, top: Dp, end: Dp,
    onClose: () -> Unit, onGroup: () -> Unit, onSeats: () -> Unit, onGallery: () -> Unit, onLogout: () -> Unit,
) {
    val c = MaterialTheme.colorScheme
    Scrim(CarMenu.Scrim, onClose)
    Surface(Modifier.align(Alignment.TopEnd).padding(top = top, end = end).width(480.dp), RoundedCornerShape(26.dp), color = CarMenu.Surface,
        border = BorderStroke(2.dp, CarMenu.Line), shadowElevation = 18.dp) {
        Column(Modifier.padding(horizontal = 24.dp, vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth().height(58.dp), verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    CharAvatar(face, 48.dp)
                    Text(name, style = menuText(29, 42), color = c.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Box(Modifier.size(48.dp).clip(CircleShape).clickable(role = Role.Button, onClick = onClose).semantics { contentDescription = "닫기" },
                    contentAlignment = Alignment.Center) { Canvas(Modifier.size(16.dp)) { cross(c.onSurface) } }
            }
            Surface(onClick = onGroup, enabled = !driving, modifier = Modifier.fillMaxWidth().height(106.dp), shape = RoundedCornerShape(18.dp), color = c.tertiaryContainer) {
                Row(Modifier.padding(horizontal = 18.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text("현재 동승 그룹", style = menuText(19, 26, FontWeight.Medium), color = c.onSurface, maxLines = 1)
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Text(group, Modifier.weight(1f, fill = false), style = menuText(25, 34), color = c.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                Image(painterResource(R.drawable.ic_menu_person), null, Modifier.size(20.dp))
                                Text("${people.size}", style = menuText(19, 26, FontWeight.Medium), color = CarMenu.Count, maxLines = 1)
                            }
                        }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        FaceGrid(people)
                        Canvas(Modifier.size(20.dp, 28.dp)) { chevron(c.onSurface) }
                    }
                }
            }
            MenuRow("좌석 배정", null, c.onSurface, !driving, onSeats)
            MenuRow("갤러리 바로가기", R.drawable.ic_menu_gallery, CarMenu.Ink, !driving, onGallery)
            if (driving) Text("그룹 변경과 좌석 배정은 주차 후에 이용해 주세요.", Modifier.fillMaxWidth(), color = c.onSurfaceVariant, style = menuText(18, 30, FontWeight.Normal))
            Surface(onClick = onLogout, modifier = Modifier.fillMaxWidth().height(60.dp), shape = RoundedCornerShape(16.dp), color = Color.Transparent) {
                Box(Modifier.padding(horizontal = 18.dp), contentAlignment = Alignment.CenterStart) {
                    Text("로그아웃", style = menuText(24, 34), color = CarMenu.ConfirmInk, maxLines = 1)
                }
            }
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

/** Menu row (2200:5876·2220:5905): 66 high, corner 16, padding 18, surface-2, icon 26 (gap 13), text 25 Bold, '›' 20×28 at the right. Off while driving. */
@Composable
private fun MenuRow(label: String, icon: Int?, ink: Color, enabled: Boolean, onClick: () -> Unit) {
    val c = MaterialTheme.colorScheme
    Surface(onClick = onClick, enabled = enabled, modifier = Modifier.fillMaxWidth().height(66.dp), shape = RoundedCornerShape(16.dp), color = c.surfaceVariant) {
        Row(Modifier.padding(horizontal = 18.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(13.dp)) {
            icon?.let { Image(painterResource(it), null, Modifier.size(26.dp)) }
            Text(label, Modifier.weight(1f), style = menuText(25, 36), color = ink, maxLines = 1)
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
