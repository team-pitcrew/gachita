package io.github.teampitcrew.gachita

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/*
 * Conversation tab of the final design (C44, Figma 2019:1966): the current trip's server transcript under 'HH:MM / place'
 * headers, speaker character and name per line, ask lines as '{이름}의 부탁' cards, a date-range chip and '추천 장면 고르기'.
 * Grouping is covered by TranscriptGroupTest.
 */

/** One row of the conversation tab. */
internal sealed interface Said {
    /** Section header 'HH:MM / place' (place null → time only). */
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

/** Date-range chip: '11월 14일 / 09:20–10:28'. One line or none falls back to that time (or the trip start). */
internal fun tripRange(createdAt: Long, lines: List<TranscriptLine>, zone: TimeZone = TimeZone.getDefault()): String {
    fun f(p: String, t: Long) = SimpleDateFormat(p, Locale.KOREA).apply { timeZone = zone }.format(Date(t))
    val first = lines.minOfOrNull { it.at } ?: createdAt
    val last = lines.maxOfOrNull { it.at } ?: createdAt
    val from = f("HH:mm", first); val to = f("HH:mm", last)
    return "${f("M월 d일", first)} / " + if (from == to) from else "$from–$to"
}

private fun clock(at: Long) = SimpleDateFormat("HH:mm", Locale.KOREA).format(Date(at))

/** Chip while driving (2026:2308 liveTranscript / 2026:2358 pausedTranscript). */
internal fun liveChip(capturing: Boolean) = "현재 주행 / 대화 기록 ${if (capturing) "중" else "멈춤"}"

/**
 * C44 body. [status] is the loading/consent/error line under the list. [canPick] gates '추천 장면 고르기'
 * (until F5 it opens the existing scene creation of the 콘텐츠 기록 tab). '말한 사람 고치기' opens trip tools (T37 fixes).
 * [live] non-null = driving (liveTranscript·pausedTranscript): read only, the chip shows [live], the newest line is kept in view,
 * and the only control is '함께 타는 중으로' ([onBack]). Fixing speakers, refreshing by hand and picking scenes stay parked-only.
 */
@Composable
internal fun TranscriptScreen(
    trip: Trip, lines: List<TranscriptLine>, asks: Set<Pair<String, Int>>, places: List<TripPlace>, loading: Boolean, status: String, canPick: Boolean,
    onRefresh: () -> Unit, onFixSpeakers: () -> Unit, onPick: () -> Unit, modifier: Modifier = Modifier, live: String? = null, onBack: () -> Unit = {},
) {
    val c = MaterialTheme.colorScheme
    val scroll = rememberScrollState()
    // 주행 중에는 손으로 넘기지 않아도 가장 새 줄이 보이게, 내용이 늘 때만 끝으로 옮긴다(움직이는 효과 없이 바로).
    if (live != null) LaunchedEffect(Unit) { snapshotFlow { scroll.maxValue }.collect { scroll.scrollTo(it) } }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("대화 기록", fontSize = 40.sp, lineHeight = 50.sp, fontWeight = FontWeight.Bold)
                Text(trip.title.ifBlank { "함께하는 여행" }, color = c.onSurfaceVariant, fontSize = 28.sp, lineHeight = 40.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (live == null) {
                TextButton(onFixSpeakers, Modifier.heightIn(min = 56.dp)) { Text("말한 사람 고치기", fontSize = 24.sp) }
                OutlinedButton(onRefresh, Modifier.heightIn(min = 56.dp), enabled = !loading, shape = RoundedCornerShape(24.dp)) { Text("새로고침", fontSize = 24.sp) }
            }
        }
        Surface(Modifier.fillMaxWidth(), RoundedCornerShape(28.dp), color = c.primaryContainer) { // 넘겨도 칩은 남는다
            Text(live ?: tripRange(trip.createdAt, lines), Modifier.padding(20.dp), color = c.onSurface, fontSize = 24.sp, lineHeight = 32.sp)
        }
        Column(Modifier.weight(1f).verticalScroll(scroll), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            transcriptItems(lines, asks, places).forEach { item ->
                when (item) {
                    is Said.Head -> Text(listOfNotNull(clock(item.at), item.place).joinToString(" / "), color = c.onSurfaceVariant, fontSize = 24.sp, lineHeight = 32.sp)
                    is Said.Line -> Bubble(item.line, trip.people.find { it.id == item.line.participantId })
                    is Said.Ask -> Surface(Modifier.fillMaxWidth(), RoundedCornerShape(28.dp), color = c.primaryContainer) {
                        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            val who = trip.people.find { it.id == item.line.participantId }
                            Text("${clock(item.line.at)} / ${who?.let { "${it.name}의 부탁" } ?: "부탁"}", color = c.onSurfaceVariant, fontSize = 24.sp, lineHeight = 32.sp)
                            Text("“${item.line.text}”", color = c.onSurface, fontSize = 28.sp, lineHeight = 40.sp)
                            if (item.line.edited) Text("수정한 자막", color = c.onSurfaceVariant, fontSize = 20.sp)
                        }
                    }
                }
            }
            if (lines.isEmpty() && !loading) Text("아직 대화 기록이 없어요. 모두 동의한 뒤 함께 타는 중에서 기록을 시작해 주세요.", color = c.onSurfaceVariant)
        }
        if (status.isNotEmpty()) Text(status, color = c.onSurfaceVariant, fontSize = 22.sp, maxLines = 2)
        if (live != null) BigButton(DriveButton("함께 타는 중으로", Press.GO, true), onBack, Modifier.fillMaxWidth().height(96.dp))
        else BigButton(DriveButton("추천 장면 고르기", if (canPick) Press.GO else Press.OFF, canPick), onPick, Modifier.fillMaxWidth().height(96.dp))
    }
}

/** One line: character (empty circle when the speaker is not confirmed) and a bubble with the name and words. */
@Composable
private fun Bubble(line: TranscriptLine, who: Person?) {
    val c = MaterialTheme.colorScheme
    Row(Modifier.padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
        if (who != null) Avatar(seatCharacter(who), 64.dp, RoundedCornerShape(16.dp)) else Box(Modifier.size(64.dp).clip(RoundedCornerShape(16.dp)).background(c.surfaceVariant))
        Surface(Modifier.weight(1f), RoundedCornerShape(6.dp, 18.dp, 18.dp, 18.dp), color = c.surface) {
            Column(Modifier.padding(horizontal = 24.dp, vertical = 18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(who?.name ?: "말한 사람 미확인", color = c.onSurfaceVariant, fontSize = 24.sp, lineHeight = 32.sp)
                Text(line.text, fontSize = 28.sp, lineHeight = 40.sp)
                if (line.edited) Text("수정한 자막", color = c.onSurfaceVariant, fontSize = 20.sp)
            }
        }
    }
}
