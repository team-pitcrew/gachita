package io.github.teampitcrew.gachita

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.log10
import kotlin.math.sqrt

/*
 * Ride tab while driving, option A '파형 중심' of the recording redesign (Figma 6I2bH121Z5pzWz2yciJUD8): D17 recording 2107:5597,
 * D18 paused 2107:5715, D19 resumed 2107:5834, D20 pre-arrival brief 2107:5952, D20p paused before arrival 2112:5678.
 * Big timer and waveform, 2×2 seats with the speaker ring, the last heard line, one big control. The parked view keeps the
 * C17 cards in Drive.kt. Pure functions are covered by RecordTest.
 */

internal const val WAVE_BARS = 60 // 6 s of 0.1 s chunks

/** Recorded time as '00:12:48'. */
internal fun recordClock(ms: Long): String = (ms / 1000).let { s -> "%02d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) }

/**
 * Bar height (0..1) of one 0.1 s chunk: RMS over both channels in dBFS, −60 dB → 0, 0 dB → 1. left/right are the per-channel sums of
 * squared samples (Chunk), values the number of samples in both channels. Quiet car noise (about −77 dBFS) stays at the floor.
 */
internal fun waveLevel(left: Double, right: Double, values: Int): Float {
    if (values <= 0 || left + right <= 0) return 0f
    val rms = sqrt((left + right) / values) / 32768.0
    return ((20 * log10(rms) + 60) / 60).toFloat().coerceIn(0f, 1f)
}

/**
 * Small status words (a pending note, e.g. an error, takes their place). D20 shows them left of the timer ('녹음' when null, '마이크 꺼짐' when paused); D17–D19 show only the
 * non-null words other than the pause, under the waveform. null means the microphone is really taking the conversation down.
 */
internal fun recordWord(paused: Boolean, playingShort: Boolean, handoff: Handoff.State, mic: Mic, why: String): String? = when {
    paused -> "마이크 꺼짐"
    playingShort -> "쇼츠를 듣는 동안은 기록하지 않아요"
    handoff == Handoff.State.WAITING -> "운전대 버튼을 누르세요"
    handoff == Handoff.State.GLEO -> "Gleo가 끝나면 기록을 이어 가요"
    mic == Mic.BLOCKED -> "마이크를 쓸 수 있으면 다시 기록해요"
    mic == Mic.FAILED -> why.ifBlank { "마이크를 열지 못했어요" }
    mic != Mic.ON -> "마이크를 켜고 있어요"
    else -> null
}

internal enum class BriefIcon { TOILET, CART, TRASH, DOT }

internal data class BriefLine(val icon: BriefIcon, val text: String)

/**
 * D20 rows ('화장실 가기 / 장보기 / 쓰레기 정리하기'): one short action per ask, every thing to buy folded into '장보기', at most three.
 * ponytail: keyword rule on the ask words. A short label from the server replaces it once the rules give one.
 */
internal fun briefLines(asks: List<SharedTodo>): List<BriefLine> = asks.map { a ->
    val words = listOfNotNull(a.title, a.text) + a.items.map { it.name }
    when {
        words.any { "화장실" in it } -> BriefLine(BriefIcon.TOILET, "화장실 가기")
        a.category == "buy" -> BriefLine(BriefIcon.CART, "장보기")
        words.any { "쓰레기" in it } -> BriefLine(BriefIcon.TRASH, "쓰레기 정리하기")
        else -> BriefLine(BriefIcon.DOT, a.title ?: a.text)
    }
}.distinct().take(3)

/** Seats drawn in the 2×2 grid: every named seat except an empty middle one, so a five-seat car with four people still reads 2×2. */
internal fun gridSeats(rows: List<List<Seat>>, people: List<Person>): List<List<Seat>> =
    rows.map { r -> r.filter { s -> !s.name.endsWith("_CENTER") || people.any { it.seat == s.name } } }.filter { it.isNotEmpty() }

// ---- UI ----

/** Last heard line: who ('서준', or the row zone when nobody is confirmed) and the words. */
internal data class LastLine(val who: String, val text: String)

@Composable
internal fun RecordView(
    paused: Boolean, word: String?, note: String, time: String, wave: List<Float>, people: List<Person>, seats: List<List<Seat>>, speaking: String?,
    last: LastLine?, near: Pair<Approach, List<BriefLine>>?, onWithdraw: (() -> Unit)?, onControl: () -> Unit, modifier: Modifier = Modifier,
) {
    val c = MaterialTheme.colorScheme
    val dot = if (paused || word != null) c.onSurfaceVariant else c.error
    Column(modifier, verticalArrangement = Arrangement.spacedBy(24.dp)) {
        Column(Modifier.weight(1f).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(24.dp)) {
            if (near == null) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        Canvas(Modifier.size(12.dp)) { drawCircle(dot) }
                        Text(time, fontSize = 72.sp, lineHeight = 90.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-1.44).sp, maxLines = 1)
                    }
                    Wave(wave, live = !paused && word == null, Modifier.widthIn(max = 720.dp).fillMaxWidth().height(140.dp))
                    (note.ifBlank { null } ?: word?.takeUnless { paused })?.let { Text(it, color = c.onSurfaceVariant, fontSize = 28.sp, lineHeight = 35.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                }
            } else {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Canvas(Modifier.size(12.dp)) { drawCircle(dot) }
                    Text(note.ifBlank { word ?: "녹음" }, Modifier.weight(1f), color = c.onSurfaceVariant, fontSize = 28.sp, lineHeight = 35.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(time, color = c.onSurfaceVariant, fontSize = 28.sp, lineHeight = 35.sp, maxLines = 1)
                }
                Brief(near.first, near.second)
            }
            SeatGrid(people, seats, speaking.takeUnless { paused }, onWithdraw)
            if (near == null) LastHeard(last, paused)
        }
        RecordControl(paused, onControl)
    }
}

/** wave/live: one red bar per chunk level (newest right, min 8dp); wave/paused: a flat row of dots in the line colour. */
@Composable
internal fun Wave(levels: List<Float>, live: Boolean, modifier: Modifier) {
    val c = MaterialTheme.colorScheme
    Canvas(modifier) {
        val w = 5.dp.toPx()
        val gap = (size.width - w * WAVE_BARS) / (WAVE_BARS - 1)
        val pad = WAVE_BARS - levels.size
        for (i in 0 until WAVE_BARS) {
            val h = if (live) maxOf(8.dp.toPx(), (levels.getOrNull(i - pad) ?: 0f) * size.height) else w
            drawRoundRect(if (live) c.error else c.outlineVariant, Offset(i * (w + gap), (size.height - h) / 2), Size(w, h), CornerRadius(3.dp.toPx()))
        }
    }
}

/** D20 '하나로마트 / 약 3분 후 도착' and the short action rows with small monochrome icons. */
@Composable
private fun Brief(a: Approach, lines: List<BriefLine>) {
    val c = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(a.place, fontSize = 56.sp, lineHeight = 70.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-1.12).sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("약 ${a.minutes}분 후 도착", color = c.primary, fontSize = 32.sp, lineHeight = 40.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
        }
        lines.forEach { l ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                Box(Modifier.size(56.dp), contentAlignment = Alignment.Center) { BriefMark(l.icon, c.onSurface, 44.dp) }
                Text(l.text, fontSize = 44.sp, lineHeight = 55.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.88).sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** '차량 앞쪽 ↑' and the seats, two per row. The speaker's face gets the accent ring and their name the accent colour. */
@Composable
private fun SeatGrid(people: List<Person>, rows: List<List<Seat>>, speaking: String?, onWithdraw: (() -> Unit)?) {
    val c = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Text("차량 앞쪽 ↑", color = c.onSurfaceVariant, fontSize = 28.sp, lineHeight = 35.sp, fontWeight = FontWeight.Medium, maxLines = 1)
            // 주행 중에도 철회는 바로(T11). 시안에는 없지만 지우지 않는다. 한 번 누르면 수음을 멈추고 이 여행의 원음과 대화를 지운다
            onWithdraw?.let { Box(Modifier.align(Alignment.CenterEnd)) { CardAction("동의 철회 · 기록 삭제", c.error, it) } }
        }
        rows.forEach { seats ->
            Row(Modifier.width(if (seats.size <= 2) 560.dp else 777.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                seats.forEach { seat ->
                    val p = people.firstOrNull { it.seat == seat.name }
                    val talking = p != null && p.id == speaking
                    Column(Modifier.width(240.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Box(Modifier.size(96.dp).clip(CircleShape).then(if (talking) Modifier.background(c.primaryContainer).border(5.dp, c.primary, CircleShape) else Modifier),
                            contentAlignment = Alignment.Center) {
                            if (p != null) Avatar(seatCharacter(p), 84.dp) else Box(Modifier.alpha(0.6f)) { EmptySeat(84.dp) }
                        }
                        Text(p?.name ?: "빈자리", color = when { p == null -> c.onSurfaceVariant; talking -> c.primary; else -> c.onSurface },
                            fontSize = 32.sp, lineHeight = 40.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}

/** D17 '서준 / 아빠, 바다는 왜 짜?'; D18 '마지막 대화' with the words in the secondary colour. */
@Composable
private fun LastHeard(last: LastLine?, paused: Boolean) {
    val c = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(if (paused) "마지막 대화" else last?.who.orEmpty(), color = c.onSurfaceVariant, fontSize = 28.sp, lineHeight = 35.sp, fontWeight = FontWeight.Medium, maxLines = 1)
        Text(last?.text ?: "아직 받아 적은 말이 없어요", color = if (paused || last == null) c.onSurfaceVariant else c.onSurface,
            fontSize = 40.sp, lineHeight = 50.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.4).sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

/** control/live '⏸ 일시정지' (ink) and control/paused '▶ 계속 기록' (accent). Pausing keeps consent; the same button resumes. */
@Composable
internal fun RecordControl(paused: Boolean, onClick: () -> Unit) {
    val c = MaterialTheme.colorScheme
    Surface(onClick = onClick, modifier = Modifier.fillMaxWidth().height(128.dp), shape = RoundedCornerShape(28.dp), color = if (paused) c.primary else c.onSurface) {
        Row(horizontalArrangement = Arrangement.spacedBy(20.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
            Canvas(Modifier.size(32.dp)) {
                val k = size.width / 32 // Figma 32 viewport paths of 2107:5586 and 2107:5590
                if (paused) drawPath(Path().apply { moveTo(10.667f * k, 6.667f * k); lineTo(25.333f * k, 16f * k); lineTo(10.667f * k, 25.333f * k); close() }, c.background)
                else listOf(9.333f, 18.667f).forEach { x -> drawRect(c.background, Offset(x * k, 6.667f * k), Size(4f * k, 18.667f * k)) }
            }
            Text(if (paused) "계속 기록" else "일시정지", Modifier.width(200.dp), color = c.background, fontSize = 40.sp, lineHeight = 50.sp,
                fontWeight = FontWeight.SemiBold, letterSpacing = (-0.4).sp, textAlign = TextAlign.Center, maxLines = 1)
        }
    }
}

/** Small monochrome marks for the brief rows (no emoji in the car UI), drawn on a 24-unit grid. */
@Composable
private fun BriefMark(icon: BriefIcon, color: Color, size: Dp) {
    Canvas(Modifier.size(size)) {
        val k = this.size.width / 24
        val line = Stroke(2f * k)
        fun p(vararg xy: Float) = Path().apply { moveTo(xy[0] * k, xy[1] * k); for (i in 2 until xy.size step 2) lineTo(xy[i] * k, xy[i + 1] * k) }
        when (icon) {
            BriefIcon.TOILET -> { // two figures and a divider, like 🚻
                drawCircle(color, 2f * k, Offset(6.5f * k, 4.5f * k)); drawRect(color, Offset(4.5f * k, 8f * k), Size(4f * k, 7f * k))
                drawRect(color, Offset(4.8f * k, 15f * k), Size(1.4f * k, 6f * k)); drawRect(color, Offset(6.8f * k, 15f * k), Size(1.4f * k, 6f * k))
                drawLine(color, Offset(12f * k, 3f * k), Offset(12f * k, 21f * k), 1.2f * k)
                drawCircle(color, 2f * k, Offset(17.5f * k, 4.5f * k)); drawPath(p(17.5f, 8f, 21f, 16f, 14f, 16f).apply { close() }, color)
                drawRect(color, Offset(15.8f * k, 16f * k), Size(1.4f * k, 5f * k)); drawRect(color, Offset(17.8f * k, 16f * k), Size(1.4f * k, 5f * k))
            }
            BriefIcon.CART -> {
                drawPath(p(2f, 4f, 5f, 4f, 7.5f, 15f, 18f, 15f, 20.5f, 7f, 6.2f, 7f), color, style = line)
                drawCircle(color, 1.8f * k, Offset(9f * k, 19.5f * k)); drawCircle(color, 1.8f * k, Offset(17f * k, 19.5f * k))
            }
            BriefIcon.TRASH -> {
                drawLine(color, Offset(3.5f * k, 6f * k), Offset(20.5f * k, 6f * k), 2f * k)
                drawPath(p(9f, 6f, 9f, 3f, 15f, 3f, 15f, 6f), color, style = line)
                drawPath(p(6f, 6f, 7f, 21f, 17f, 21f, 18f, 6f), color, style = line)
                drawLine(color, Offset(10f * k, 10f * k), Offset(10f * k, 17f * k), 1.6f * k); drawLine(color, Offset(14f * k, 10f * k), Offset(14f * k, 17f * k), 1.6f * k)
            }
            BriefIcon.DOT -> drawCircle(color, 3f * k)
        }
    }
}
