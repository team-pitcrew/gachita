package io.github.teampitcrew.gachita

import androidx.compose.foundation.BorderStroke
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.layout.ContentScale
import androidx.compose.foundation.border
import androidx.compose.foundation.Image
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
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
// 차 화면은 시스템 설정과 관계없이 늘 어두운 화면이다(최종 시안의 C·D 프레임, 11/15 오너 결정). 밝은 화면 색표는 두지 않는다.
// 어두운 화면은 밝은 민트 바탕에 검은 글자. outline은 테두리 단추·칩의 경계라 바탕과 구별되게, outlineVariant는 구분선.
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

/**
 * 글꼴: Pretendard 1.3.9 정적 OTF 넷(res/font, SIL OFL 1.1 — assets/licenses/pretendard-OFL.txt). 시안 글자 스타일(Car/…)이 모두 Pretendard다(docs/design.md 4절).
 * Pleos 시스템에도 'pretendard'라는 이름이 있지만 /product/etc/fonts_customization.xml에서 AstaSans로 이어져, 시스템 이름이 아니라 앱에 담은 파일을 쓴다.
 */
val Pretendard = FontFamily(
    Font(R.font.pretendard_regular, FontWeight.Normal),
    Font(R.font.pretendard_medium, FontWeight.Medium),
    Font(R.font.pretendard_semibold, FontWeight.SemiBold),
    Font(R.font.pretendard_bold, FontWeight.Bold),
)

private fun TextStyle.pretendard() = copy(fontFamily = Pretendard)

// 칩·단추(labelLarge)와 입력란(bodyLarge)의 기본 14~16sp는 차 화면에서 작다. 주행 화면 글자는 24sp 이상.
private val CarType = Typography().run {
    Typography(
        displayLarge = displayLarge.pretendard(), displayMedium = displayMedium.pretendard(), displaySmall = displaySmall.pretendard(),
        headlineLarge = headlineLarge.pretendard(), headlineMedium = headlineMedium.pretendard(), headlineSmall = headlineSmall.pretendard(),
        titleLarge = titleLarge.pretendard(), titleMedium = titleMedium.pretendard(), titleSmall = titleSmall.pretendard(),
        bodyLarge = TextStyle(fontFamily = Pretendard, fontSize = 24.sp), bodyMedium = bodyMedium.pretendard(), bodySmall = bodySmall.pretendard(),
        labelLarge = TextStyle(fontFamily = Pretendard, fontSize = 24.sp, fontWeight = FontWeight.SemiBold),
        labelMedium = labelMedium.pretendard(), labelSmall = labelSmall.pretendard(),
    )
}

@Composable
fun GachitaTheme(content: @Composable () -> Unit) =
    MaterialTheme(colorScheme = Dark, typography = CarType) {
        ProvideTextStyle(TextStyle(fontFamily = Pretendard, fontSize = 24.sp), content)
    }

/**
 * 여행 화면의 두 껍데기(시안). RIDE: 함께 타는 중·대화 기록(녹음 화면 A안 2107:5597·C44 2019:1966, 여백 32, 머리 줄 64·간격 12, 칸 간격 24).
 * PARKED: 도착 브리핑·콘텐츠 기록(C20·D19·C22–C38, 여백 40, 머리 줄 80·간격 18, 칸 간격 24).
 */
enum class Shell(val padH: Dp, val padV: Dp, val head: Dp, val headGap: Dp, val gap: Dp) {
    RIDE(32.dp, 32.dp, 64.dp, 12.dp, 24.dp),
    PARKED(40.dp, 40.dp, 80.dp, 18.dp, 24.dp),
}

/** 카드의 바탕. 기록 상태 머리만 색을 바꾸고 나머지는 Plain이다. */
enum class Tone { Plain, Rec, Wait, Accent }

/** 차 화면 카드. 모서리 32dp, 테두리 없이 바탕색으로 구분한다. Accent는 지금 답이 필요한 카드(제안·도착 브리핑)에만. 도착 브리핑(시안 C3)은 안쪽 여백 40·간격 20. 높이를 고정할 칸은 modifier로 준다(T83). */
@Composable
fun CarCard(tone: Tone = Tone.Plain, modifier: Modifier = Modifier, pad: Dp = 28.dp, gap: Dp = 10.dp, content: @Composable ColumnScope.() -> Unit) {
    val c = MaterialTheme.colorScheme
    val bg = when (tone) { Tone.Plain, Tone.Accent -> c.surface; Tone.Rec -> c.errorContainer; Tone.Wait -> c.secondaryContainer }
    Surface(modifier.fillMaxWidth(), RoundedCornerShape(32.dp), color = bg, border = if (tone == Tone.Accent) BorderStroke(3.dp, c.onPrimaryContainer) else null) {
        Column(Modifier.padding(pad), verticalArrangement = Arrangement.spacedBy(gap), content = content)
    }
}

/** 투명 PNG 전신을 Fit로 표시한다. 강조 테두리는 이미지를 자르지 않으며, 이 공통 컴포넌트는 움직이지 않는다. */
@Composable
fun Character(index: Int, size: Dp, ring: Boolean = false) {
    val ringMod = if (ring) Modifier.border(3.dp, MaterialTheme.colorScheme.onPrimaryContainer, RoundedCornerShape(16.dp)).padding(3.dp) else Modifier
    Image(painterResource(SEAT_CHARS.getOrElse(index) { SEAT_CHARS[0] }), null, Modifier.size(size).then(ringMod), contentScale = ContentScale.Fit)
}

/**
 * 동그란(또는 둥근 네모) 캐릭터 얼굴(최종 시안 C17 일행·받아 적은 말, C44 대화 기록의 'Character / 원본' 칸). 시안처럼 칸을 캐릭터가 크게 채우게
 * 전신 PNG를 1.45배로 키워 머리와 윗몸이 보이게 자르고, 밝은 바탕 위에 둔다(시안 조각의 밝은 파스텔 바탕). 그림 자체는 바꾸지 않는다.
 * ring은 말하는 사람 테두리(6dp, 시안 accent-text). 전신이 필요한 곳(가족 고르기, 쇼츠 무대)은 Character를 쓴다.
 */
@Composable
fun Avatar(index: Int, size: Dp, shape: Shape = CircleShape, ring: Boolean = false) = CharAvatar(SEAT_CHARS.getOrElse(index) { SEAT_CHARS[0] }, size, shape, ring)

/** 참가자의 얼굴 그림: 그룹 여행이면 그 프로필의 캐릭터(Person.character), 손님이면 자리 순서(SEAT_CHARS). */
fun faceRes(p: Person): Int = if (p.character.isNotBlank()) charDrawable(p.character)
    else SEAT_CHARS.getOrElse(Seat.entries.indexOfFirst { it.name == p.seat }.coerceAtLeast(0)) { SEAT_CHARS[0] }

@Composable
fun Avatar(p: Person, size: Dp, shape: Shape = CircleShape, ring: Boolean = false) = CharAvatar(faceRes(p), size, shape, ring)

/** Avatar와 같은 잘라 채우기를 캐릭터 그림(res/drawable-nodpi/char_*)으로. 온보딩·가족의 프로필 캐릭터(시안 'Character / 원본', 모서리 48). */
@Composable
fun CharAvatar(res: Int, size: Dp, shape: Shape = CircleShape, ring: Boolean = false) {
    val c = MaterialTheme.colorScheme
    Box(Modifier.size(size).then(if (ring) Modifier.border(6.dp, c.onPrimaryContainer, shape) else Modifier).clip(shape).background(c.onSurface)) {
        Image(painterResource(res), null,
            Modifier.fillMaxSize().graphicsLayer { scaleX = 1.45f; scaleY = 1.45f; transformOrigin = TransformOrigin(0.5f, 0.32f) },
            contentScale = ContentScale.Fit)
    }
}

/** 빈자리: 점선 동그라미. */
@Composable
fun EmptySeat(size: Dp) {
    val line = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)
    Canvas(Modifier.size(size)) { drawCircle(line, this.size.minDimension / 2 - 2.dp.toPx(), style = Stroke(3.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(14f, 12f)))) }
}

/** 가치타 마스코트(최종 시안 Mascot 7:544, res/drawable/mascot.xml). 정지 그림이고 녹음 상태는 옆 상태 표시에서 안내한다. 설치 아이콘은 따로(launcher art). */
@Composable
fun Mascot(listening: Boolean, size: Dp = 56.dp) {
    Image(
        painter = painterResource(R.drawable.mascot),
        contentDescription = if (listening) "가치타 · 대화 기록 중" else "가치타",
        modifier = Modifier.size(size),
        contentScale = ContentScale.Fit,
    )
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
    val (bg, fg) = if (ok) c.tertiaryContainer to c.tertiary else c.errorContainer to c.error // 시안 ok-soft·ok
    Row(Modifier.clip(CircleShape).background(bg).padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Canvas(Modifier.size(14.dp)) { drawCircle(fg) } // 시안 pill(2014:940): 점 14, 위아래 8
        Text(text, color = fg, style = CarText.Label, maxLines = 1) // 시안 pill 글 24 Medium/32
    }
}
