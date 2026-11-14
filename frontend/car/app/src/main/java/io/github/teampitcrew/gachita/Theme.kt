package io.github.teampitcrew.gachita

import androidx.compose.foundation.BorderStroke
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.layout.ContentScale
import androidx.compose.foundation.border
import androidx.compose.foundation.Image
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/*
 * 차 화면의 색·글자·모양과 그림 조각(T20). 시안: https://www.figma.com/design/bkASxUWEfhJKjawI1sVK8n
 * 색 이름은 frontend/web/style.css의 토큰과 같다. 밤과 시스템 다크에서는 어두운 값을 쓴다.
 * 주행 화면 기준(docs/emulator/README.md, Android for Cars): 글자 24sp 이상, 움직이는 표시 없음.
 */

// 디자인 1급 문서(11/14): 상징색은 원본 캐릭터 시트의 민트, 바탕·글자는 따뜻한 미색·먹색.
// Material 단추는 primary를 글자색(테두리 단추)으로도 쓰므로, 밝은 화면의 primary는 흰 바탕 위 글자로 읽히는 짙은 민트다
// (밝은 민트 #60C090은 흰 바탕과 2.2:1). 어두운 화면은 밝은 민트 바탕에 검은 글자.
// outline은 테두리 단추·칩의 경계라 바탕과 구별되게, outlineVariant는 구분선.
private val Light = lightColorScheme(
    background = Color(0xFFF6F4F1), surface = Color(0xFFFFFFFF), surfaceVariant = Color(0xFFF1EEE9),
    onBackground = Color(0xFF28221B), onSurface = Color(0xFF28221B), onSurfaceVariant = Color(0xFF5A5044),
    outline = Color(0xFFA39A8E), outlineVariant = Color(0xFFEDEAE6), surfaceContainerHighest = Color(0xFFE3DED6),
    primary = Color(0xFF2B7A53), primaryContainer = Color(0xFFE4F4EC), onPrimary = Color(0xFFFFFFFF), onPrimaryContainer = Color(0xFF2B7A53),
    error = Color(0xFFB3261E), errorContainer = Color(0xFFFCE8E6), onErrorContainer = Color(0xFF28221B),
    tertiary = Color(0xFF2B7A53), tertiaryContainer = Color(0xFFE4F4EC),
    secondary = Color(0xFF8C6400), secondaryContainer = Color(0xFFFBF1DC), onSecondaryContainer = Color(0xFF28221B),
)
private val Dark = darkColorScheme(
    background = Color(0xFF12110F), surface = Color(0xFF1C1A17), surfaceVariant = Color(0xFF26231F),
    onBackground = Color(0xFFF4F1EC), onSurface = Color(0xFFF4F1EC), onSurfaceVariant = Color(0xFFB5ADA2),
    outline = Color(0xFF6B645A), outlineVariant = Color(0xFF34302A), surfaceContainerHighest = Color(0xFF34302A),
    primary = Color(0xFF6FD3A6), primaryContainer = Color(0xFF1C3A2D), onPrimary = Color(0xFF12110F), onPrimaryContainer = Color(0xFF7FDDB2),
    error = Color(0xFFFF8A80), errorContainer = Color(0xFF3A1F1E), onErrorContainer = Color(0xFFF4F1EC),
    tertiary = Color(0xFF7FDDB2), tertiaryContainer = Color(0xFF1C3A2D),
    secondary = Color(0xFFF5C766), secondaryContainer = Color(0xFF3A2F17), onSecondaryContainer = Color(0xFFF4F1EC),
)

/**
 * 원본 시트에서 캐릭터별 전신을 분리하고 가려진 부분을 복원한 투명 PNG(res/drawable-nodpi/char_*.png).
 * 원본의 형태·색·소품을 유지하며 얼굴만 자르거나 이웃 캐릭터를 함께 표시하지 않는다.
 * 차의 손님 참가자에는 캐릭터 값이 없어 자리 순서로 고른다(운전석부터 기본·캡모자·안경·여행·게임).
 */
private val SEAT_CHARS = listOf(R.drawable.char_basic, R.drawable.char_cap, R.drawable.char_glasses, R.drawable.char_travel, R.drawable.char_game)

// 칩·단추(labelLarge)와 입력란(bodyLarge)의 기본 14~16sp는 차 화면에서 작다. 주행 화면 글자는 24sp 이상.
private val CarType = Typography(
    labelLarge = TextStyle(fontSize = 24.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = TextStyle(fontSize = 24.sp),
)

@Composable
fun GachitaTheme(content: @Composable () -> Unit) =
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light, typography = CarType) {
        ProvideTextStyle(TextStyle(fontSize = 24.sp), content)
    }

/** 카드의 바탕. 기록 상태 머리만 색을 바꾸고 나머지는 Plain이다. */
enum class Tone { Plain, Rec, Wait, Accent }

/** 차 화면 카드. 모서리 32dp, 테두리 없이 바탕색으로 구분한다. Accent는 지금 답이 필요한 카드(제안·도착 브리핑)에만. 높이를 고정할 칸은 modifier로 준다(T83). */
@Composable
fun CarCard(tone: Tone = Tone.Plain, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val c = MaterialTheme.colorScheme
    val bg = when (tone) { Tone.Plain, Tone.Accent -> c.surface; Tone.Rec -> c.errorContainer; Tone.Wait -> c.secondaryContainer }
    Surface(modifier.fillMaxWidth(), RoundedCornerShape(32.dp), color = bg, border = if (tone == Tone.Accent) BorderStroke(3.dp, c.onPrimaryContainer) else null) {
        Column(Modifier.padding(28.dp), verticalArrangement = Arrangement.spacedBy(10.dp), content = content)
    }
}

private const val INK = 0xFF28221B

/** 64 단위 좌표로 그린다(피그마·웹의 SVG와 같은 좌표). */
private fun DrawScope.in64(block: DrawScope.() -> Unit) = scale(size.minDimension / 64f, Offset.Zero, block)

private val carPath = Path().apply {
    moveTo(14f, 22f); cubicTo(14f, 16.5f, 18.5f, 12f, 24f, 12f); lineTo(40f, 12f); cubicTo(45.5f, 12f, 50f, 16.5f, 50f, 22f); lineTo(50f, 24f); lineTo(54f, 24f)
    cubicTo(56.2f, 24f, 58f, 25.8f, 58f, 28f); lineTo(58f, 44f); cubicTo(58f, 48.4f, 54.4f, 52f, 50f, 52f); lineTo(14f, 52f)
    cubicTo(9.6f, 52f, 6f, 48.4f, 6f, 44f); lineTo(6f, 28f); cubicTo(6f, 25.8f, 7.8f, 24f, 10f, 24f); lineTo(14f, 24f); close()
}

private fun DrawScope.face(y: Float, closed: Boolean) {
    val ink = Color(INK)
    if (closed) {
        for (x in listOf(24f, 40f)) drawPath(Path().apply { moveTo(x - 4, y); quadraticTo(x, y + 3, x + 4, y) }, ink, style = Stroke(2.6f, cap = StrokeCap.Round))
    } else {
        drawCircle(ink, 2.8f, Offset(24.5f, y)); drawCircle(ink, 2.8f, Offset(39.5f, y))
        drawPath(Path().apply { moveTo(28.5f, y + 6.5f); quadraticTo(32f, y + 9.5f, 35.5f, y + 6.5f) }, ink, style = Stroke(2.4f, cap = StrokeCap.Round))
    }
}

/** 투명 PNG 전신을 Fit로 표시한다. 강조 테두리는 이미지를 자르지 않으며, 이 공통 컴포넌트는 움직이지 않는다. */
@Composable
fun Character(index: Int, size: Dp, ring: Boolean = false) {
    val ringMod = if (ring) Modifier.border(3.dp, MaterialTheme.colorScheme.onPrimaryContainer, RoundedCornerShape(16.dp)).padding(3.dp) else Modifier
    Image(painterResource(SEAT_CHARS.getOrElse(index) { SEAT_CHARS[0] }), null, Modifier.size(size).then(ringMod), contentScale = ContentScale.Fit)
}

/** 빈자리: 점선 동그라미. */
@Composable
fun EmptySeat(size: Dp) {
    val line = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)
    Canvas(Modifier.size(size)) { drawCircle(line, this.size.minDimension / 2 - 2.dp.toPx(), style = Stroke(3.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(14f, 12f)))) }
}

/** 가치타 본체 마스코트(차 모양). 상태는 자세로만 바꾼다: 듣는 중은 눈을 뜨고 민트 점, 멈춤은 눈을 감는다(Grok Bot의 원리만). */
@Composable
fun Mascot(listening: Boolean, size: Dp = 56.dp) {
    val c = MaterialTheme.colorScheme
    Canvas(Modifier.size(size).clip(RoundedCornerShape(16.dp)).background(c.primaryContainer).padding(4.dp)) {
        in64 {
            drawPath(carPath, Color.White)
            drawPath(carPath, Color(INK), style = Stroke(3f, join = StrokeJoin.Round))
            face(36f, closed = !listening)
            if (listening) drawCircle(Color(0xFF60C090), 6f, Offset(52f, 12f))
        }
    }
}

/** 화면 맨 위 줄: 마스코트, 이름, 여행 제목, 오른쪽에 상태 알약(주차 중 · P, 서버 연결됨 — 시안 C1·C5·C6). 알약은 (글, 괜찮은지). */
@Composable
fun AppBar(title: String, listening: Boolean, vararg pills: Pair<String, Boolean>) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Mascot(listening)
        Text("가치타", fontSize = 32.sp, fontWeight = FontWeight.Bold)
        Text(title, Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        pills.forEach { (text, ok) -> Pill(text, ok) }
    }
}

/** 상태 알약: 점과 글. 괜찮으면 민트, 아니면 빨강 기운. 움직이지 않는다. */
@Composable
fun Pill(text: String, ok: Boolean = true) {
    val c = MaterialTheme.colorScheme
    val (bg, fg) = if (ok) c.primaryContainer to c.onPrimaryContainer else c.errorContainer to c.error
    Row(Modifier.clip(CircleShape).background(bg).padding(horizontal = 20.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Canvas(Modifier.size(12.dp)) { drawCircle(fg) }
        Text(text, color = fg, maxLines = 1)
    }
}

@Composable
fun SeatMap(
    people: List<Person>, zone: Int?, highlight: String? = null, size: Dp = 80.dp, car: CarStatus = CarStatus(),
    note: ((Person) -> Pair<String, Color>)?, compact: Boolean = false,
) {
    val c = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(40.dp)).background(c.surfaceVariant).padding(if (compact) 8.dp else 16.dp), verticalArrangement = Arrangement.spacedBy(if (compact) 4.dp else 8.dp)) {
        for ((row, seats) in seatRows(car.seats).withIndex()) {
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(28.dp)).then(if (zone == row) Modifier.background(c.primaryContainer).border(3.dp, c.onPrimaryContainer, RoundedCornerShape(28.dp)) else Modifier).padding(vertical = if (compact) 6.dp else 12.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
            ) {
                for (seat in seats) {
                    val p = people.firstOrNull { it.seat == seat.name }
                    Column(if (compact) Modifier.weight(1f) else Modifier.width(size + 40.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(if (compact) 4.dp else 6.dp)) {
                        val label = p?.name ?: if (seat.name in car.occupied) "앉아 있어요" else "빈자리"
                        if (compact) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                if (p == null) EmptySeat(36.dp) else Character(seat.ordinal, 36.dp, ring = p.id == highlight)
                                Text(label, fontWeight = if (p != null) FontWeight.Bold else null, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        } else {
                            if (p == null) EmptySeat(size) else Character(seat.ordinal, size, ring = p.id == highlight)
                            Text(label, fontWeight = if (p != null) FontWeight.Bold else null, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        if (p != null) note?.invoke(p)?.let { (text, color) -> Text(text, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    }
                }
            }
        }
    }
}
