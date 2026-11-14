package io.github.teampitcrew.gachita

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/*
 * Ride tab of the final design (Figma fJmxFDb3TrpycwDjGJNP62, page 2004:57): C17/C17p recording and paused,
 * C19/C19p and finalNear/finalPaused approaching the next place (flow F4, T141), C21/C21p driving on after an arrival,
 * the resumed and ended states, plus the header and tab bar (C13 look). The arrival brief itself is Arrival.kt.
 * Slots keep fixed sizes so cards appearing or disappearing never shift the other slots while driving (T11, T83).
 * The pure functions here are covered by DriveTest.
 */

/** Background of the status card: recording (red tint), paused or blocked (amber tint), anything else (plain). */
internal enum class Hero { REC, PAUSED, PLAIN }

internal data class DriveStatus(val title: String, val sub: String, val hero: Hero)

/**
 * Status card text for the current recording state. Mirrors the old StatusHero order, with the design's '기록' wording.
 * ended: the trip's server status is 'ended' (2026:2410). resumed: recording came back from a pause and nothing new was heard yet (2026:1969).
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

/** Look of the full-width bottom button: stop (red tint), go (accent), off (disabled). */
internal enum class Press { STOP, GO, OFF }

internal data class DriveButton(val label: String, val press: Press, val enabled: Boolean)

/**
 * The one big control (C17 '기록 중지', C17p '기록 재개', ended '새 여행 시작'). Recording starts by itself once the trip turns to driving with
 * everyone's consent (Session.autoStart, C03·C13), so there is no start button: before that the button only says so. Pause and resume keep
 * consent; without consent it opens passenger setup while parked. An ended trip never records again; a new trip is started while parked.
 */
internal fun driveButton(recording: Boolean, muted: Boolean, agreed: Boolean, restricted: Boolean, ended: Boolean = false): DriveButton = when {
    ended && restricted -> DriveButton("주차한 뒤 새 여행을 시작해요", Press.OFF, false)
    ended -> DriveButton("새 여행 시작", Press.GO, true)
    recording && !muted -> DriveButton("기록 중지", Press.STOP, true)
    recording -> DriveButton("기록 재개", Press.GO, true)
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

/** Pre-arrival brief (C19, finalNear 2043:1835): the next place from the navigation and whole minutes left, rounded up. final: no waypoint left. */
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
 * One short phrase per ask for the narrow card. C19 '하은 화장실 / 고기와 과일 / 간식과 음료', finalNear '하은 화장실 / 엄마 냉장 보관 /
 * 아빠 체크인과 가방 챙기기': things to buy as a list of goods, anything else with the confirmed requester's name in front, things to bring
 * end with '챙기기'. Older servers without action items give the ask text.
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

// ---- UI ----

/**
 * Which frame the trip screen uses. The design has two, chosen by what is on screen, not by the window width: the ride and conversation
 * tabs (C17·C21·C44·D33, ended) use [Shell.RIDE] with the '● 연결됨' chip; the parked screens (arrival brief C20·D19·finalBrief, the
 * content tab C22–C38) use [Shell.PARKED] with '주차 중  P'.
 */
internal fun tripShell(parked: Boolean, showsBrief: Boolean, contentTab: Boolean): Shell = if (parked && (showsBrief || contentTab)) Shell.PARKED else Shell.RIDE

/**
 * Header row (C17: mascot, '가치타', '● 연결됨'; C13·C20: '주차 중  P'). The window-size button (T112, [extra]) sits next to '주차 중  P'
 * on parked screens; on the ride and conversation tabs it is in 여행 관리.
 */
@Composable
internal fun TripHeader(shell: Shell, gear: String?, online: Boolean, listening: Boolean, extra: @Composable () -> Unit = {}) {
    val c = MaterialTheme.colorScheme
    val park = shell == Shell.PARKED
    Row(Modifier.fillMaxWidth().height(shell.head), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(shell.headGap)) {
        Mascot(listening, 48.dp)
        Text("가치타", fontSize = 32.sp, lineHeight = 42.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.weight(1f))
        if (!online) Pill("연결 대기", ok = false) else if (!park) Pill("연결됨")
        if (park) { Text(if (gear == "P") "주차 중  P" else "정차 중", color = c.onSurfaceVariant, fontSize = 24.sp, maxLines = 1); extra() }
    }
}

/** Top tabs (함께 타는 중 / 대화 기록 / 콘텐츠 기록). Disabled tabs keep the same look as the design; they just do not respond. */
@Composable
internal fun TripTabs(labels: List<String>, selected: Int, enabled: (Int) -> Boolean, onSelect: (Int) -> Unit) {
    val c = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().height(76.dp).clip(RoundedCornerShape(20.dp)).background(c.surfaceVariant).padding(4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        labels.forEachIndexed { i, label ->
            val on = i == selected
            Surface(onClick = { onSelect(i) }, enabled = enabled(i), modifier = Modifier.weight(1f).fillMaxHeight(), shape = RoundedCornerShape(16.dp),
                color = if (on) c.primaryContainer else Color.Transparent) {
                Box(contentAlignment = Alignment.Center) {
                    Text(label, color = if (on) c.onSurface else c.onSurfaceVariant, fontSize = 24.sp, fontWeight = FontWeight.Medium, maxLines = 1)
                }
            }
        }
    }
}

/**
 * Slot layout of the ride tab: status card, middle card (takes the remaining height), seat card, big button.
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
    Surface(onClick = onClick, enabled = b.enabled, modifier = modifier, shape = RoundedCornerShape(24.dp), color = bg) {
        Box(contentAlignment = Alignment.Center) { Text(b.label, color = fg, fontSize = 32.sp, lineHeight = 42.sp, fontWeight = FontWeight.Bold, maxLines = 1) }
    }
}

/** Small pill-shaped action inside a card (Gleo, consent withdrawal, trip tools). 56dp tall, 24sp, like the other car buttons. */
@Composable
internal fun CardAction(label: String, color: Color = MaterialTheme.colorScheme.primary, onClick: () -> Unit) {
    OutlinedButton(onClick, Modifier.heightIn(min = 56.dp), shape = RoundedCornerShape(24.dp), border = BorderStroke(2.dp, color.copy(alpha = 0.5f)),
        contentPadding = PaddingValues(horizontal = 18.dp)) { Text(label, color = color, fontSize = 24.sp, maxLines = 1) }
}

/** C17 status card: '● 기록 중' / '● 기록 멈춤' with the sub line. A pending note (errors, consent results) replaces the sub line. */
@Composable
internal fun StatusCard(status: DriveStatus, note: String, actions: @Composable RowScope.() -> Unit = {}) {
    val c = MaterialTheme.colorScheme
    val (bg, fg) = when (status.hero) { Hero.REC -> c.errorContainer to c.error; Hero.PAUSED -> c.secondaryContainer to c.secondary; Hero.PLAIN -> c.surface to c.onSurface }
    Surface(Modifier.fillMaxWidth().heightIn(min = 140.dp), RoundedCornerShape(32.dp), color = bg) {
        Column(Modifier.padding(horizontal = 28.dp, vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                if (status.hero != Hero.PLAIN) Canvas(Modifier.size(24.dp)) { drawCircle(fg) }
                Text(status.title, Modifier.weight(1f), color = fg, fontSize = if (status.title.length <= 5) 56.sp else 44.sp, lineHeight = 64.sp,
                    fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                actions()
            }
            Text(note.ifBlank { status.sub }, color = c.onSurfaceVariant, fontSize = 24.sp, lineHeight = 32.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** One heard line: speaker character (empty circle when unknown), '{name} / {seat}', the words. */
internal data class HeardRow(val meta: String, val text: String, val character: Int?)

/**
 * C17 '방금 받아 적은 말 N건' / C17p '멈추기 전 마지막 대화' (dimmed). Newest first, no auto scroll. Each row is the speaker's round avatar,
 * '{name} / {seat}' and the sentence, wrapping to two lines like the design. The slot fits one wrapped sentence plus one more line, so when
 * the newest sentence wraps the older row is left out instead of being cut off.
 */
@Composable
internal fun HeardCard(title: String, counts: String, rows: List<HeardRow>, dim: Boolean, modifier: Modifier) {
    val c = MaterialTheme.colorScheme
    var newestWraps by remember(rows.firstOrNull()?.text) { mutableStateOf(false) }
    Surface(modifier, RoundedCornerShape(32.dp), color = c.surface) {
        Column(Modifier.padding(horizontal = 24.dp, vertical = 16.dp).then(if (dim) Modifier.alpha(0.6f) else Modifier), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, Modifier.weight(1f), fontSize = 24.sp, lineHeight = 32.sp, fontWeight = FontWeight.Medium, maxLines = 1)
                if (counts.isNotEmpty()) Text(counts, color = c.onSurfaceVariant, fontSize = 24.sp, maxLines = 1)
            }
            if (rows.isEmpty()) Text("아직 받아 적은 말이 없어요", color = c.onSurfaceVariant, fontSize = 28.sp)
            rows.take(if (newestWraps) 1 else 2).forEachIndexed { i, r ->
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    if (r.character != null) Avatar(r.character, 48.dp) else Box(Modifier.size(48.dp).clip(CircleShape).background(c.surfaceVariant))
                    Column(Modifier.weight(1f)) {
                        Text(r.meta, color = c.onSurfaceVariant, fontSize = 24.sp, lineHeight = 32.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(r.text, fontSize = 28.sp, lineHeight = 40.sp, maxLines = if (i == 0) 2 else 1, overflow = TextOverflow.Ellipsis,
                            onTextLayout = { if (i == 0) newestWraps = it.lineCount > 1 })
                    }
                }
            }
        }
    }
}

/** C19·finalNear '{place} 도착까지 약 N분' card in the middle slot. Details are shown after parking (C20, finalBrief). */
@Composable
internal fun NearCard(a: Approach, line: String, modifier: Modifier) {
    val c = MaterialTheme.colorScheme
    Surface(modifier, RoundedCornerShape(32.dp), color = c.primaryContainer) {
        Column(Modifier.padding(horizontal = 24.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("${a.place} 도착까지 약 ${a.minutes}분", color = c.primary, fontSize = 24.sp, lineHeight = 32.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("내리기 전, 기억할 부탁", color = c.onSurface, fontSize = 32.sp, lineHeight = 42.sp, fontWeight = FontWeight.Bold, maxLines = 1)
            Text(line, Modifier.weight(1f, fill = false), color = c.onSurface, fontSize = 28.sp, lineHeight = 40.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text("주차 후 자세히 보여드릴게요.", color = c.onSurfaceVariant, fontSize = 24.sp, lineHeight = 32.sp, maxLines = 1)
        }
    }
}

/**
 * C17 '일행 N명' seat card. Rows and seats come from the car's seat areas (seatRows). The speaking person gets a ring and
 * '· 말하는 중', and their row (or the heard row zone, T37) gets the accent background. Consent notes appear only for people
 * who have not consented yet, so the recording view matches the design. compact = one line for short windows.
 */
@Composable
internal fun SeatCard(
    people: List<Person>, car: CarStatus, speaking: String?, zone: Int?, compact: Boolean,
    note: (Person) -> Pair<String, Color>?, header: @Composable RowScope.() -> Unit = {},
) {
    val c = MaterialTheme.colorScheme
    Surface(Modifier.fillMaxWidth(), RoundedCornerShape(32.dp), color = c.surface) {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Text("일행 ${people.size}명", Modifier.weight(1f), fontSize = 32.sp, lineHeight = 42.sp, fontWeight = FontWeight.Bold, maxLines = 1)
                header()
                if (!compact) Text("차 앞쪽 ▲", color = c.onSurfaceVariant, fontSize = 24.sp, maxLines = 1)
            }
            if (compact) {
                val who = people.find { it.id == speaking }
                Text(people.joinToString(" · ") { if (it == who) "${it.name}(말하는 중)" else it.name }, color = c.onSurfaceVariant, fontSize = 24.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
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
                                    fontSize = 24.sp, lineHeight = 32.sp, fontWeight = if (talking) FontWeight.Bold else FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                )
                                p?.let(note)?.let { (text, color) -> Text(text, color = color, fontSize = 20.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                            }
                        }
                    }
                }
            }
        }
    }
}
