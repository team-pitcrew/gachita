package io.github.teampitcrew.gachita

import androidx.compose.foundation.BorderStroke
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
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
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
import java.util.Locale

/*
 * Ride tab of the design 'Y7zFqGUEAFDWTumG30MsOs' (page 2004:57). While recording (paused included) it is option A '파형 중심' that the owner
 * chose (section 2107:6979): D17 recording 2107:5597, D18 paused 2107:5715, D19 resumed 2107:5834, D20 before arrival 2107:5952, D20p
 * 2112:5678 — big timer, waveform, 2×2 seats with the speaker ring, the last heard line, one big control. Before recording, an ended trip
 * (2026:2410), a rest-stop offer and voice enrolment keep the C17 cards. The header carries the '내 얼굴' button and the profile dropdown
 * (C17m 2206:5852, docs/design.md §5). Pure functions are covered by DriveTest.
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

/** Bar heights of the design's wave/live (2107:5463) over its 140 box. Only the debug demo draws it; the real screen draws captured levels. */
internal val DESIGN_WAVE = listOf(8, 47, 23, 23, 12, 24, 71, 11, 105, 44, 60, 25, 20, 75, 15, 123, 47, 77, 41, 11, 35, 14, 70, 27, 48, 29, 15, 10, 10, 31,
    16, 36, 28, 22, 17, 10, 45, 24, 79, 63, 54, 51, 9, 48, 26, 108, 81, 77, 77, 17, 16, 16, 72, 53, 55, 54, 17, 17, 9, 28).map { it / 140f }

internal enum class BriefIcon { TOILET, CART, TRASH, COLD, BAG, DOT }

internal data class BriefLine(val icon: BriefIcon, val text: String)

/**
 * D20 rows ('화장실 가기 / 장보기 / 쓰레기 정리하기'): one short action per ask with a monochrome mark (no emoji in the car), every thing to buy
 * folded into '장보기', at most three. Anything else keeps the ask's title (finalNear '고기는 바로 냉장 보관').
 * ponytail: keyword rule on the ask words. A short label from the server replaces it once the rules give one.
 */
internal fun briefLines(asks: List<SharedTodo>): List<BriefLine> = asks.map { a ->
    val words = listOfNotNull(a.title, a.text) + a.items.map { it.name }
    fun has(re: String) = words.any { Regex(re).containsMatchIn(it) }
    val title = a.title ?: a.text
    when {
        has("화장실") -> BriefLine(BriefIcon.TOILET, "화장실 가기")
        a.category == "buy" -> BriefLine(BriefIcon.CART, "장보기")
        has("쓰레기") -> BriefLine(BriefIcon.TRASH, "쓰레기 정리하기")
        has("냉장|냉동|얼음") -> BriefLine(BriefIcon.COLD, title)
        has("가방|짐|캐리어|트렁크") -> BriefLine(BriefIcon.BAG, title)
        else -> BriefLine(BriefIcon.DOT, title)
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

/** Tab text of the ride shell (A·C44 상위 탭: 80 high, 28 SemiBold). The parked shell keeps Car/Label 24 at 76. */
internal val RideTabText: TextStyle = CarText.Body.copy(fontWeight = FontWeight.SemiBold)

/**
 * Header row (A·C44: mascot, '가치타', '● 연결됨'; C20: '주차 중  P'), and at the right end the '내 얼굴' button ([me], C17m, docs/design.md §5).
 * The window-size button (T112, [extra]) sits next to '주차 중  P' on parked screens; on the ride and conversation tabs it is in 여행 관리.
 */
@Composable
internal fun TripHeader(shell: Shell, gear: String?, online: Boolean, listening: Boolean, extra: @Composable () -> Unit = {}, me: (@Composable () -> Unit)? = null) {
    val c = MaterialTheme.colorScheme
    val park = shell == Shell.PARKED
    Row(Modifier.fillMaxWidth().height(shell.head), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(shell.headGap)) {
        Mascot(listening, 48.dp)
        Text("가치타", style = CarText.Headline, maxLines = 1)
        Spacer(Modifier.weight(1f))
        if (!online) Pill("연결 대기", ok = false) else if (!park) Pill("연결됨")
        if (park) { Text(if (gear == "P") "주차 중  P" else "정차 중", color = c.onSurfaceVariant, style = CarText.Label, maxLines = 1); extra() }
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

// ---- option A: recording window ----

/** Last heard line: who ('서준', or '말한 사람 미확인 / 뒷좌석' when nobody is confirmed) and the words. */
internal data class LastLine(val who: String, val text: String)

/**
 * Option A body. [status] decides the look: REC = red dot, red timer that runs, captured waveform; the user's pause = grey dot, timer in ink,
 * flat line, '마지막 대화'; other holds (Gleo, shorts, microphone) = grey dot and their sub line where the wave was. A pending [note]
 * (an error, a consent result) takes that place too. [near] swaps the timer block for the D20 brief. [onGleo] and [onWithdraw] are not in
 * the design but stay (T41 hand-off, T11 withdrawal in one tap while driving) on the '차량 앞쪽 ↑' line.
 */
@Composable
internal fun RecordView(
    status: DriveStatus, paused: Boolean, note: String, time: String, wave: List<Float>,
    people: List<Person>, seats: List<List<Seat>>, occupied: Set<String>, speaking: String?, consentNote: (Person) -> Pair<String, Color>?,
    last: LastLine?, unsent: Int, near: Pair<Approach, List<BriefLine>>?, control: DriveButton, onControl: () -> Unit,
    onGleo: (() -> Unit)?, onWithdraw: (() -> Unit)?, modifier: Modifier = Modifier,
) {
    val c = MaterialTheme.colorScheme
    val live = status.hero == Hero.REC && !paused
    val dot = if (live) c.error else c.onSurfaceVariant
    val word = note.ifBlank { null } ?: status.sub.takeUnless { live || paused }
    BoxWithConstraints(modifier) {
        // 시안은 841×1210 창(본문 954, '차량 앞쪽' 줄의 56 단추까지 950을 씀). 낮은 창에서는 시안의 wave/live/medium(96)·small(42)로 줄이고
        // 마지막 말을 한 줄로, 도착 전 브리핑은 두 줄로
        val waveH = when { maxHeight >= 950.dp -> 140.dp; maxHeight >= 906.dp -> 96.dp; else -> 42.dp }
        val lastLines = if (maxHeight >= 852.dp) 2 else 1
        val nearRows = if (maxHeight >= 950.dp) 3 else 2
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            Column(Modifier.weight(1f).fillMaxWidth().clipToBounds(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(24.dp)) {
                if (near == null) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                            Canvas(Modifier.size(12.dp)) { drawCircle(dot) }
                            // 기록 타이머는 기록 중에만 rec(design.md §3, C17 '19:11'), 멈추면 ink. 1초에 한 번 글자만 바뀐다
                            Text(time, color = if (live) c.error else c.onSurface, style = CarText.Status, maxLines = 1)
                        }
                        Box(Modifier.widthIn(max = 720.dp).fillMaxWidth().height(waveH), contentAlignment = Alignment.Center) {
                            if (word != null) Text(word, color = if (note.isNotBlank()) c.onSurfaceVariant else c.secondary, style = CarText.Body,
                                textAlign = TextAlign.Center, maxLines = if (waveH > 42.dp) 2 else 1, overflow = TextOverflow.Ellipsis)
                            else Wave(wave, live, Modifier.fillMaxSize())
                        }
                    }
                } else {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Canvas(Modifier.size(12.dp)) { drawCircle(dot) }
                        Text(note.ifBlank { when { live -> "녹음"; paused -> "마이크 꺼짐"; else -> status.title } }, Modifier.weight(1f),
                            color = c.onSurfaceVariant, style = CarText.Body, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(time, color = c.onSurfaceVariant, style = CarText.Body, maxLines = 1)
                    }
                    NearCard(near.first, near.second.take(nearRows), Modifier.fillMaxWidth())
                }
                SeatGrid(people, seats, occupied, speaking.takeIf { live }, consentNote, onGleo, onWithdraw)
                if (near == null) LastHeard(last, paused, unsent, lastLines)
            }
            RecordControl(control, onControl)
        }
    }
}

/**
 * wave/live: one red bar per 0.1 s level (newest right, at least 8dp); wave/paused: a flat row in the line colour.
 * The levels are the ones captured up to the newest heard line (Live.wave), so the shape changes only when new text comes in and never moves
 * by itself while driving (Pleos driver-distraction guide: no moving or blinking indicators).
 */
@Composable
internal fun Wave(levels: List<Float>, live: Boolean, modifier: Modifier) {
    val c = MaterialTheme.colorScheme
    Canvas(modifier) {
        val w = 5.dp.toPx()
        val gap = (size.width - w * WAVE_BARS) / (WAVE_BARS - 1)
        val pad = WAVE_BARS - levels.size
        for (i in 0 until WAVE_BARS) {
            val h = if (live) maxOf(8.dp.toPx(), (levels.getOrNull(i - pad) ?: 0f).coerceIn(0f, 1f) * size.height) else 6.dp.toPx()
            drawRoundRect(if (live) c.error else c.outlineVariant, Offset(i * (w + gap), (size.height - h) / 2), Size(w, h), CornerRadius(3.dp.toPx()))
        }
    }
}

/**
 * D20 '하나로마트 / 약 3분 후 도착' and the short action rows with monochrome marks (2107:5979). Option A draws it in place of the timer
 * block; before recording the C17 cards put it in the middle slot. Details are shown after parking (C20, finalBrief, flow F4).
 */
@Composable
internal fun NearCard(a: Approach, lines: List<BriefLine>, modifier: Modifier) {
    val c = MaterialTheme.colorScheme
    val semi = FontWeight.SemiBold
    Column(modifier, verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(a.place, style = CarText.Status.copy(fontWeight = semi), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("약 ${a.minutes}분 후 도착", color = c.primary, style = CarText.Headline.copy(fontWeight = semi), maxLines = 1)
        }
        lines.forEach { l ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                Box(Modifier.size(50.dp), contentAlignment = Alignment.Center) { BriefMark(l.icon, c.onSurface, 44.dp) } // 시안 56 칸, 줄 높이(Title 50)에 맞춤
                Text(l.text, style = CarText.Title.copy(fontWeight = semi), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/**
 * '차량 앞쪽 ↑' and the seats, two per row (560 wide, 240 per seat). The speaker's face gets the accent ring on accent-soft and their name
 * the accent colour (A 2107:5698). Consent notes appear only for people who have not consented yet.
 */
@Composable
private fun SeatGrid(
    people: List<Person>, rows: List<List<Seat>>, occupied: Set<String>, speaking: String?, consentNote: (Person) -> Pair<String, Color>?,
    onGleo: (() -> Unit)?, onWithdraw: (() -> Unit)?,
) {
    val c = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Text("차량 앞쪽 ↑", color = c.onSurfaceVariant, style = CarText.Body, maxLines = 1)
            // 시안에 없는 Gleo 넘기기(T41)와 주행 중 바로 하는 철회(T11): 한 번 누르면 수음을 멈추고 이 여행의 원음과 대화를 지운다
            onGleo?.let { Box(Modifier.align(Alignment.CenterStart)) { CardAction("Gleo에게 말하기", onClick = it) } }
            onWithdraw?.let { Box(Modifier.align(Alignment.CenterEnd)) { CardAction("동의 철회 · 기록 삭제", c.error, it) } }
        }
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
                            if (p != null) Avatar(seatCharacter(p), 84.dp) else Box(Modifier.alpha(0.6f)) { EmptySeat(84.dp) }
                        }
                        Text(
                            when { p == null -> if (seat.name in occupied) "앉아 있어요" else "빈자리"; else -> p.name },
                            color = when { p == null -> c.onSurfaceVariant; talking -> c.primary; else -> c.onSurface },
                            style = CarText.Headline.copy(fontWeight = FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                        p?.let(consentNote)?.let { (text, color) -> Text(text, color = color, style = CarText.Label, maxLines = 1) }
                    }
                }
            }
        }
    }
}

/** D17 '서준 / 아빠, 바다는 왜 짜?'; D18 '마지막 대화' with the words in ink-2. Parked with unsent lines, '미전송 N' at the right. */
@Composable
private fun LastHeard(last: LastLine?, paused: Boolean, unsent: Int, lines: Int) {
    val c = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(if (paused) "마지막 대화" else last?.who.orEmpty(), Modifier.weight(1f), color = c.onSurfaceVariant, style = CarText.Body, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (unsent > 0) Text("미전송 $unsent", color = c.onSurfaceVariant, style = CarText.Label, maxLines = 1) // 주차 중 원음을 잃지 않게(T63)
        }
        Text(last?.text ?: "아직 받아 적은 말이 없어요", color = if (paused || last == null) c.onSurfaceVariant else c.onSurface,
            style = CarText.Title.copy(fontWeight = FontWeight.SemiBold, letterSpacing = (-0.01).em), maxLines = lines, overflow = TextOverflow.Ellipsis)
    }
}

/** control/live '⏸ 일시정지' (ink, 2107:5585) and control/paused '▶ 계속 기록' (accent, 2107:5589): 128 high, corner 28, icon 32, gap 20. */
@Composable
internal fun RecordControl(b: DriveButton, onClick: () -> Unit) {
    val c = MaterialTheme.colorScheme
    val (bg, fg) = when (b.press) { Press.STOP -> c.onSurface to c.background; Press.GO -> c.primary to c.background; Press.OFF -> c.surfaceVariant to c.onSurfaceVariant }
    Surface(onClick = onClick, enabled = b.enabled, modifier = Modifier.fillMaxWidth().height(128.dp), shape = RoundedCornerShape(28.dp), color = bg) {
        Row(horizontalArrangement = Arrangement.spacedBy(20.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
            if (b.press != Press.OFF) Canvas(Modifier.size(32.dp)) {
                val k = size.width / 32 // 시안 32 칸의 경로(2107:5586 멈춤 막대 둘, 2107:5590 재생 세모)
                if (b.press == Press.GO) drawPath(Path().apply { moveTo(10.667f * k, 6.667f * k); lineTo(25.333f * k, 16f * k); lineTo(10.667f * k, 25.333f * k); close() }, fg)
                else listOf(9.333f, 18.667f).forEach { x -> drawRect(fg, Offset(x * k, 6.667f * k), Size(4f * k, 18.667f * k)) }
            }
            Text(b.label, color = fg, style = CarText.Title.copy(fontWeight = FontWeight.SemiBold, letterSpacing = (-0.01).em), textAlign = TextAlign.Center, maxLines = 1)
        }
    }
}

/** Small monochrome marks for the brief rows (no emoji in the car UI), drawn on a 24-unit grid. */
@Composable
private fun BriefMark(icon: BriefIcon, color: Color, size: Dp) {
    Canvas(Modifier.size(size)) {
        val k = this.size.width / 24
        val line = Stroke(2f * k, cap = StrokeCap.Round)
        fun p(vararg xy: Float) = Path().apply { moveTo(xy[0] * k, xy[1] * k); for (i in 2 until xy.size step 2) lineTo(xy[i] * k, xy[i + 1] * k) }
        fun o(x: Float, y: Float) = Offset(x * k, y * k)
        when (icon) {
            BriefIcon.TOILET -> { // two figures and a divider, like the design's 🚻
                drawCircle(color, 2f * k, o(6.5f, 4.5f)); drawRect(color, o(4.5f, 8f), Size(4f * k, 7f * k))
                drawRect(color, o(4.8f, 15f), Size(1.4f * k, 6f * k)); drawRect(color, o(6.8f, 15f), Size(1.4f * k, 6f * k))
                drawLine(color, o(12f, 3f), o(12f, 21f), 1.2f * k)
                drawCircle(color, 2f * k, o(17.5f, 4.5f)); drawPath(p(17.5f, 8f, 21f, 16f, 14f, 16f).apply { close() }, color)
                drawRect(color, o(15.8f, 16f), Size(1.4f * k, 5f * k)); drawRect(color, o(17.8f, 16f), Size(1.4f * k, 5f * k))
            }
            BriefIcon.CART -> {
                drawPath(p(2f, 4f, 5f, 4f, 7.5f, 15f, 18f, 15f, 20.5f, 7f, 6.2f, 7f), color, style = line)
                drawCircle(color, 1.8f * k, o(9f, 19.5f)); drawCircle(color, 1.8f * k, o(17f, 19.5f))
            }
            BriefIcon.TRASH -> {
                drawLine(color, o(3.5f, 6f), o(20.5f, 6f), 2f * k)
                drawPath(p(9f, 6f, 9f, 3f, 15f, 3f, 15f, 6f), color, style = line)
                drawPath(p(6f, 6f, 7f, 21f, 17f, 21f, 18f, 6f), color, style = line)
                drawLine(color, o(10f, 10f), o(10f, 17f), 1.6f * k); drawLine(color, o(14f, 10f), o(14f, 17f), 1.6f * k)
            }
            BriefIcon.COLD -> { // snowflake: three crossing strokes with small tips
                listOf(0f, 60f, 120f).forEach { deg ->
                    val r = Math.toRadians(deg.toDouble()); val dx = (9 * Math.cos(r)).toFloat(); val dy = (9 * Math.sin(r)).toFloat()
                    drawLine(color, o(12f - dx, 12f - dy), o(12f + dx, 12f + dy), 2f * k, StrokeCap.Round)
                }
                drawCircle(color, 2f * k, o(12f, 12f))
            }
            BriefIcon.BAG -> { // suitcase with a handle
                drawRoundRect(color, o(3f, 8f), Size(18f * k, 13f * k), CornerRadius(2.5f * k), style = line)
                drawPath(p(9f, 8f, 9f, 4.5f, 15f, 4.5f, 15f, 8f), color, style = line)
                drawLine(color, o(3f, 13f), o(21f, 13f), 1.6f * k)
            }
            BriefIcon.DOT -> drawCircle(color, 3f * k)
        }
    }
}

// ---- C17 cards: before recording, ended trip (2026:2410), rest-stop offer, voice enrolment ----

/**
 * Slot layout: status card, middle card (takes the remaining height), seat card, big button.
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

/** Small pill-shaped action inside a card (Gleo, consent withdrawal, trip tools). 56dp tall, Car/Label 24, like the other car buttons. */
@Composable
internal fun CardAction(label: String, color: Color = MaterialTheme.colorScheme.primary, onClick: () -> Unit) {
    OutlinedButton(onClick, Modifier.heightIn(min = 56.dp), shape = CarShape.Ctl, border = BorderStroke(2.dp, color.copy(alpha = 0.5f)),
        contentPadding = PaddingValues(horizontal = 18.dp)) { Text(label, color = color, style = CarText.Label, maxLines = 1) }
}

/** Status hero (ended 2026:2419): '● 여행 기록 완료' with the sub line. A pending note (errors, consent results) replaces the sub line. */
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

/** One heard line: speaker character (empty circle when unknown), '{name} / {seat}', the words. */
internal data class HeardRow(val meta: String, val text: String, val character: Int?)

/**
 * ended '멈추기 전 마지막 대화' (dimmed) and the parked '방금 받아 적은 말 N건'. Newest first, no auto scroll. Each row is the speaker's round
 * avatar, '{name} / {seat}' and the sentence. The slot fits one wrapped sentence plus one more line, so when the newest sentence wraps the
 * older row is left out instead of being cut off.
 */
@Composable
internal fun HeardCard(title: String, counts: String, rows: List<HeardRow>, dim: Boolean, modifier: Modifier) {
    val c = MaterialTheme.colorScheme
    var newestWraps by remember(rows.firstOrNull()?.text) { mutableStateOf(false) }
    Surface(modifier, CarShape.Card, color = c.surface) {
        Column(Modifier.padding(horizontal = 24.dp, vertical = 16.dp).then(if (dim) Modifier.alpha(0.6f) else Modifier), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, Modifier.weight(1f), style = CarText.Label, maxLines = 1)
                if (counts.isNotEmpty()) Text(counts, color = c.onSurfaceVariant, style = CarText.Label, maxLines = 1)
            }
            if (rows.isEmpty()) Text("아직 받아 적은 말이 없어요", color = c.onSurfaceVariant, style = CarText.Body)
            rows.take(if (newestWraps) 1 else 2).forEachIndexed { i, r ->
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    if (r.character != null) Avatar(r.character, 48.dp) else Box(Modifier.size(48.dp).clip(CircleShape).background(c.surfaceVariant))
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
 * Seat map card (ended 2026:2436, '일행 N명'). Rows and seats come from the car's seat areas (seatRows). The speaking person gets a ring and
 * '· 말하는 중', and their row (or the heard row zone, T37) gets the accent background. Consent notes appear only for people who have not
 * consented yet. compact = one line for short windows.
 */
@Composable
internal fun SeatCard(
    people: List<Person>, car: CarStatus, speaking: String?, zone: Int?, compact: Boolean,
    note: (Person) -> Pair<String, Color>?, header: @Composable RowScope.() -> Unit = {},
) {
    val c = MaterialTheme.colorScheme
    Surface(Modifier.fillMaxWidth(), CarShape.Card, color = c.surface) {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Text("일행 ${people.size}명", Modifier.weight(1f), style = CarText.Headline, maxLines = 1)
                header()
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
            // 시안은 차체 여백 12·줄 여백 12. 머리의 56dp 단추(동의 철회·동승자 설정)만큼 줄여 가운데 칸 높이를 시안대로 둔다
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(40.dp)).background(c.surfaceVariant).padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                rows.forEachIndexed { i, seats ->
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(28.dp)).then(if (i == speakingRow) Modifier.background(c.primaryContainer) else Modifier)
                        .padding(horizontal = 8.dp, vertical = 10.dp)) {
                        seats.forEach { seat ->
                            val p = people.firstOrNull { it.seat == seat.name }
                            val talking = p != null && p.id == speaking
                            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                when {
                                    p == null -> Box(Modifier.alpha(0.6f)) { EmptySeat(80.dp) }
                                    else -> Avatar(seatCharacter(p), 80.dp, ring = talking)
                                }
                                Text(
                                    when { p == null -> if (seat.name in car.occupied) "앉아 있어요" else "빈자리"; talking -> "${p.name} · 말하는 중"; else -> p.name },
                                    color = when { p == null -> c.onSurfaceVariant; talking -> c.onPrimaryContainer; else -> c.onSurface },
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

// ---- header '내 얼굴' button and profile dropdown (C17m 2206:5852, logout check 2220:5864, docs/design.md §5) ----

/** Dropdown border: a design value (#7A9C87, design.md §5 '시안 값, 변수 아님') with no Material role, kept here only. */
private val MENU_LINE = Color(0xFF7A9C87)

/** '내 얼굴' button at the right end of the header: 64 to press, face 54 (2206:5857). */
@Composable
internal fun MeButton(face: Int, onClick: () -> Unit) {
    Box(Modifier.size(64.dp).clip(CircleShape).clickable(role = Role.Button, onClick = onClick).semantics { contentDescription = "프로필 메뉴 열기" },
        contentAlignment = Alignment.Center) { CharAvatar(face, 54.dp) }
}

/**
 * Profile dropdown under the face button ([top]: 8 below the header, C17m 104; 480 wide, corner 26, border #7A9C87 2, outside #000 56%): face and name with 닫기, the current
 * riding group (2×2 faces, name, people), 좌석 배정, 갤러리 바로가기, 로그아웃 (danger). While driving, seat assignment and the gallery are
 * blocked with '그룹 변경과 좌석 배정은 주차 후에 이용해 주세요.'. [onManage] (여행 관리, parked only) is not in the design: the A screen has
 * no status card for it any more, so it lives here.
 */
@Composable
internal fun BoxScope.ProfileMenu(
    name: String, face: Int, group: String, people: List<Person>, driving: Boolean, top: Dp, end: Dp,
    onClose: () -> Unit, onSeats: () -> Unit, onGallery: () -> Unit, onManage: (() -> Unit)?, onLogout: () -> Unit,
) {
    val c = MaterialTheme.colorScheme
    Scrim(0.56f, onClose)
    Surface(Modifier.align(Alignment.TopEnd).padding(top = top, end = end).width(480.dp), RoundedCornerShape(26.dp), color = c.surface,
        border = BorderStroke(2.dp, MENU_LINE), shadowElevation = 16.dp) {
        Column(Modifier.padding(horizontal = 24.dp, vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth().height(86.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                CharAvatar(face, 48.dp)
                Text(name, Modifier.weight(1f), style = CarText.Headline, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Box(Modifier.size(48.dp).clip(CircleShape).clickable(role = Role.Button, onClick = onClose).semantics { contentDescription = "닫기" },
                    contentAlignment = Alignment.Center) { Canvas(Modifier.size(20.dp)) { cross(c.onSurface) } }
            }
            // 현재 동승 그룹(ok-soft). 그룹 바꾸기는 여행이 열려 있는 동안 갈 화면이 없어 누르지 않는다(가족 흐름은 여행이 없을 때만 열림)
            Surface(Modifier.fillMaxWidth().height(114.dp), RoundedCornerShape(18.dp), color = c.tertiaryContainer) {
                Row(Modifier.padding(horizontal = 18.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(group, Modifier.weight(1f, fill = false), style = CarText.Headline, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Canvas(Modifier.size(20.dp)) { person(c.onSurfaceVariant) }
                    Text("${people.size}", color = c.onSurfaceVariant, style = CarText.Label, maxLines = 1)
                    Spacer(Modifier.weight(1f))
                    FaceGrid(people)
                }
            }
            MenuRow("좌석 배정", !driving, onSeats)
            MenuRow("갤러리 바로가기", !driving, onGallery) { gallery(it) }
            onManage?.let { MenuRow("여행 관리", !driving, it) }
            Surface(onClick = onLogout, modifier = Modifier.fillMaxWidth().height(60.dp), shape = RoundedCornerShape(16.dp), color = c.errorContainer) {
                Row(Modifier.padding(horizontal = 18.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(13.dp)) {
                    Canvas(Modifier.size(26.dp)) { logout(c.error) }
                    Text("로그아웃", color = c.error, style = CarText.Label.copy(fontWeight = FontWeight.Bold), maxLines = 1)
                }
            }
            if (driving) Text("그룹 변경과 좌석 배정은 주차 후에 이용해 주세요.", Modifier.fillMaxWidth(), color = c.onSurfaceVariant, style = CarText.Label, textAlign = TextAlign.Center)
        }
    }
}

/** Logout check (2220:5864): 480×232 in the middle, outside #000 62% cancels. 취소 (surface-2) and 로그아웃 (danger: rec-soft, rec). */
@Composable
internal fun BoxScope.LogoutConfirm(onCancel: () -> Unit, onLogout: () -> Unit) {
    val c = MaterialTheme.colorScheme
    Scrim(0.62f, onCancel)
    Surface(Modifier.align(Alignment.Center).width(480.dp), RoundedCornerShape(26.dp), color = c.surface, border = BorderStroke(2.dp, MENU_LINE), shadowElevation = 16.dp) {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("로그아웃할까요?", style = CarText.Headline, maxLines = 1)
            Text("로그아웃하면 시작 화면으로 돌아가요.", color = c.onSurfaceVariant, style = CarText.Label)
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Surface(onClick = onCancel, modifier = Modifier.weight(1f).height(68.dp), shape = RoundedCornerShape(16.dp), color = c.surfaceVariant) {
                    Box(contentAlignment = Alignment.Center) { Text("취소", style = CarText.Label.copy(fontWeight = FontWeight.Bold), maxLines = 1) }
                }
                Surface(onClick = onLogout, modifier = Modifier.weight(1f).height(68.dp), shape = RoundedCornerShape(16.dp), color = c.errorContainer) {
                    Box(contentAlignment = Alignment.Center) { Text("로그아웃", color = c.error, style = CarText.Label.copy(fontWeight = FontWeight.Bold), maxLines = 1) }
                }
            }
        }
    }
}

/** Dims the screen behind a dropdown or check; pressing it cancels. */
@Composable
private fun BoxScope.Scrim(alpha: Float, onClick: () -> Unit) {
    Box(Modifier.matchParentSize().background(Color.Black.copy(alpha = alpha))
        .clickable(remember { MutableInteractionSource() }, indication = null, onClick = onClick))
}

/** List row button (design.md §5: 66 high, corner 16, surface-2 + ink, '›' at the right). Off while driving. */
@Composable
private fun MenuRow(label: String, enabled: Boolean, onClick: () -> Unit, icon: (DrawScope.(Color) -> Unit)? = null) {
    val c = MaterialTheme.colorScheme
    Surface(onClick = onClick, enabled = enabled, modifier = Modifier.fillMaxWidth().height(66.dp), shape = RoundedCornerShape(16.dp), color = c.surfaceVariant) {
        Row(Modifier.padding(horizontal = 18.dp).alpha(if (enabled) 1f else 0.5f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            icon?.let { draw -> Canvas(Modifier.size(24.dp)) { draw(c.onSurface) } }
            Text(label, Modifier.weight(1f), style = CarText.Label.copy(fontWeight = FontWeight.Bold), maxLines = 1)
            Canvas(Modifier.size(20.dp, 28.dp)) { chevron(c.onSurface) }
        }
    }
}

/** Group faces 2×2 (32 each, 4 apart; design.md §5 'Group / 2x2'). */
@Composable
private fun FaceGrid(people: List<Person>) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        people.take(4).chunked(2).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) { row.forEach { Avatar(seatCharacter(it), 32.dp) } }
        }
    }
}

private fun DrawScope.cross(color: Color) {
    val w = 2.5.dp.toPx()
    drawLine(color, Offset(0f, 0f), Offset(size.width, size.height), w, StrokeCap.Round)
    drawLine(color, Offset(size.width, 0f), Offset(0f, size.height), w, StrokeCap.Round)
}

private fun DrawScope.chevron(color: Color) {
    val w = 2.5.dp.toPx(); val x = size.width * 0.35f; val y = size.height / 2
    drawLine(color, Offset(x, y - 7.dp.toPx()), Offset(x + 7.dp.toPx(), y), w, StrokeCap.Round)
    drawLine(color, Offset(x + 7.dp.toPx(), y), Offset(x, y + 7.dp.toPx()), w, StrokeCap.Round)
}

private fun DrawScope.person(color: Color) {
    drawCircle(color, size.width * 0.22f, Offset(size.width / 2, size.height * 0.3f))
    drawArc(color, 180f, 180f, true, Offset(size.width * 0.12f, size.height * 0.58f), Size(size.width * 0.76f, size.height * 0.8f))
}

private fun DrawScope.gallery(color: Color) {
    val k = size.width / 24; val line = Stroke(2f * k, cap = StrokeCap.Round)
    drawRoundRect(color, Offset(3f * k, 4f * k), Size(18f * k, 16f * k), CornerRadius(2.5f * k), style = line)
    drawPath(Path().apply { moveTo(4f * k, 18f * k); lineTo(10f * k, 11f * k); lineTo(14f * k, 15f * k); lineTo(16f * k, 13f * k); lineTo(20f * k, 17f * k) }, color, style = line)
    drawCircle(color, 1.6f * k, Offset(16f * k, 8.5f * k))
}

private fun DrawScope.logout(color: Color) {
    val k = size.width / 24; val line = Stroke(2f * k, cap = StrokeCap.Round)
    drawPath(Path().apply { moveTo(10f * k, 4f * k); lineTo(5f * k, 4f * k); lineTo(5f * k, 20f * k); lineTo(10f * k, 20f * k) }, color, style = line)
    drawLine(color, Offset(10f * k, 12f * k), Offset(20f * k, 12f * k), 2f * k, StrokeCap.Round)
    drawPath(Path().apply { moveTo(16f * k, 8f * k); lineTo(20f * k, 12f * k); lineTo(16f * k, 16f * k) }, color, style = line)
}
