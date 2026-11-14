package io.github.teampitcrew.gachita

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/*
 * Conversation tab of the design (C44 2019:1966, wide D33 2019:2052, liveTranscript 2026:2308; pausedTranscript 2026:2358 follows the live frame with
 * '대화 기록 멈춤'): the trip title and date range, then the current trip's server transcript as a chat — 'HH:MM  place' section heads,
 * the speaker's character, name and a bubble with the time; the driver's own lines on the right in accent-soft ('아빠 (나)').
 * Grouping is covered by TranscriptGroupTest.
 */

/** One row of the conversation tab. */
internal sealed interface Said {
    /** Section header 'HH:MM  place' (place null → time only). */
    data class Head(val at: Long, val place: String?) : Said
    data class Line(val line: TranscriptLine) : Said
    /** A line the server turned into a todo. It carries its own header, so the next ordinary line opens a new section. */
    data class Ask(val line: TranscriptLine) : Said
}

/** A silence longer than this starts a new section even at the same place. */
internal const val SECTION_GAP_MS = 10 * 60_000L

/** The last recorded trip place at or before [at], if the transcript carries places (A3). */
internal fun placeAt(at: Long, places: List<TripPlace>): String? = places.filter { it.at <= at }.maxByOrNull { it.at }?.name

/** Builds the rows: a header whenever the place changes, the gap exceeds [SECTION_GAP_MS] or an ask card came in between. */
internal fun transcriptItems(lines: List<TranscriptLine>, asks: Set<Pair<String, Int>>, places: List<TripPlace>): List<Said> {
    val out = mutableListOf<Said>()
    var last: TranscriptLine? = null
    var lastPlace: String? = null
    var open = false // an ordinary section is open and the next line can join it
    for (line in lines.sortedBy { it.at }) {
        if (line.device to line.seq in asks) { out += Said.Ask(line); open = false; last = line; continue }
        val place = placeAt(line.at, places)
        if (!open || place != lastPlace || last == null || line.at - last.at > SECTION_GAP_MS) out += Said.Head(line.at, place)
        out += Said.Line(line)
        open = true; last = line; lastPlace = place
    }
    return out
}

/** Date range under the title (C44): '11월 14일  09:20–10:28'. One line or none falls back to that time (or the trip start). */
internal fun tripRange(createdAt: Long, lines: List<TranscriptLine>, zone: TimeZone = TimeZone.getDefault()): String {
    fun f(p: String, t: Long) = SimpleDateFormat(p, Locale.KOREA).apply { timeZone = zone }.format(Date(t))
    val first = lines.minOfOrNull { it.at } ?: createdAt
    val last = lines.maxOfOrNull { it.at } ?: createdAt
    val from = f("HH:mm", first); val to = f("HH:mm", last)
    return "${f("M월 d일", first)}  " + if (from == to) from else "$from–$to"
}

private fun clock(at: Long) = SimpleDateFormat("HH:mm", Locale.KOREA).format(Date(at))

/** Line under the title while driving (liveTranscript 2026:2308 '대화 기록 중'; paused '대화 기록 멈춤'). */
internal fun liveChip(capturing: Boolean) = "대화 기록 ${if (capturing) "중" else "멈춤"}"

/** Bubble words (Conversation / Car 36 Medium): the nearest car step, Headline 32 at Medium weight. */
private val BubbleText = CarText.Headline.copy(fontWeight = FontWeight.Medium, letterSpacing = CarText.Body.letterSpacing)

/**
 * C44 body. [status] is the loading/consent/error line under the list. [canPick] gates '추천 장면 고르기' (scene picking, C23).
 * '말한 사람 고치기' opens trip tools (T37 fixes). [me] is the driver's own participant id ('(나)', right side).
 * [live] non-null = driving (liveTranscript·pausedTranscript): read only, the line under the title shows [live], the newest line is kept in
 * view, and the only control is '함께 타는 중으로' ([onBack]). Fixing speakers and picking scenes stay parked-only; the list reloads whenever
 * the tab opens. Ask lines are ordinary bubbles in the revised C44 (no '○○의 부탁' card).
 */
@Composable
internal fun TranscriptScreen(
    trip: Trip, lines: List<TranscriptLine>, places: List<TripPlace>, loading: Boolean, status: String, canPick: Boolean,
    onFixSpeakers: () -> Unit, onPick: () -> Unit, modifier: Modifier = Modifier, live: String? = null, me: String? = null, onBack: () -> Unit = {},
) {
    val c = MaterialTheme.colorScheme
    val scroll = rememberScrollState()
    // 주행 중에는 손으로 넘기지 않아도 가장 새 줄이 보이게, 내용이 늘 때만 끝으로 옮긴다(움직이는 효과 없이 바로).
    if (live != null) LaunchedEffect(Unit) { snapshotFlow { scroll.maxValue }.collect { scroll.scrollTo(it) } }
    // 넓은 창(D33 2019:2052)은 1120 폭의 대화 줄을 가운데에 둔다
    Box(modifier, contentAlignment = Alignment.TopCenter) { Column(Modifier.widthIn(max = 1120.dp).fillMaxSize(), verticalArrangement = Arrangement.spacedBy(24.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(trip.title.ifBlank { "함께하는 여행" }, style = CarText.Title, maxLines = 1, overflow = TextOverflow.Ellipsis) // 시안 48 → Car/Title 40
                Text(live ?: tripRange(trip.createdAt, lines), color = c.onSurfaceVariant, style = CarText.Body, maxLines = 1)
            }
            // 시안 C44에는 단추가 없다. 잘못 붙은 화자를 고치는 길(T37)만 남기고, 다시 불러오기는 탭을 열 때마다 한다
            if (live == null) TextButton(onFixSpeakers, Modifier.heightIn(min = 56.dp)) { Text("말한 사람 고치기", style = CarText.Label) }
        }
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(scroll), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            transcriptItems(lines, emptySet(), places).forEach { item ->
                when (item) {
                    is Said.Head -> Text(listOfNotNull(clock(item.at), item.place).joinToString("  "), Modifier.fillMaxWidth(), color = c.onSurfaceVariant,
                        style = CarText.Label, textAlign = TextAlign.Center)
                    is Said.Line -> Bubble(item.line, trip.people.find { it.id == item.line.participantId }, me)
                    is Said.Ask -> Bubble(item.line, trip.people.find { it.id == item.line.participantId }, me)
                }
            }
            if (lines.isEmpty() && !loading) Text("아직 대화 기록이 없어요. 모두 동의한 뒤 함께 타는 중에서 기록을 시작해 주세요.", color = c.onSurfaceVariant, style = CarText.Body)
        }
        if (status.isNotEmpty()) Text(status, color = c.onSurfaceVariant, style = CarText.Label, maxLines = 2)
        // 하단 작업(시안 112 높이, accent)
        if (live != null) CarButton("함께 타는 중으로", height = 112.dp, onClick = onBack)
        else CarButton("추천 장면 고르기", enabled = canPick, height = 112.dp, onClick = onPick)
    } }
}

/**
 * One line (Conversation / Car 2120:5693·5701): others on the left with the character (72, empty circle when not confirmed), name and a
 * surface-2 bubble with the time after it; the driver's own line on the right as '{name} (나)' in accent-soft with the time before it.
 */
@Composable
private fun Bubble(line: TranscriptLine, who: Person?, me: String?) {
    val c = MaterialTheme.colorScheme
    val mine = who != null && who.id == me
    val words: @Composable () -> Unit = {
        Column(Modifier.padding(horizontal = 24.dp, vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(line.text, style = BubbleText)
            if (line.edited) Text("수정한 자막", color = c.onSurfaceVariant, style = CarText.Label)
        }
    }
    val time: @Composable () -> Unit = { Text(clock(line.at), color = c.onSurfaceVariant, style = CarText.Label, maxLines = 1) }
    if (mine) Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("${who!!.name} (나)", color = c.onSurfaceVariant, style = CarText.Body, maxLines = 1)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.End), verticalAlignment = Alignment.Bottom) {
            time()
            Surface(Modifier.weight(1f, fill = false), RoundedCornerShape(28.dp, 6.dp, 28.dp, 28.dp), color = c.primaryContainer) { words() }
        }
    } else Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(18.dp)) {
        if (who != null) Avatar(seatCharacter(who), 72.dp) else Box(Modifier.size(72.dp).clip(CircleShape).background(c.surfaceVariant))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(who?.name ?: "말한 사람 미확인", color = c.onSurfaceVariant, style = CarText.Body, maxLines = 1)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Bottom) {
                Surface(Modifier.weight(1f, fill = false), RoundedCornerShape(6.dp, 28.dp, 28.dp, 28.dp), color = c.surfaceVariant) { words() }
                time()
            }
        }
    }
}
