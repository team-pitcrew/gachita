package io.github.teampitcrew.gachita

import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.Image
import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

/*
 * 차 화면 공통 디자인 시스템(T156). 기준은 원본 Figma `Y7zFqGUEAFDWTumG30MsOs` '민준 개선안'(2004:57)과 docs/design.md 3·4절.
 * 색은 Theme.kt의 Material 역할(시안 변수 → 역할 표는 design.md 3절)로만 쓰고, 글자는 아래 CarText, 모양은 CarShape를 쓴다.
 * 화면 파일은 여기 조각을 조립하고, 시안에 같은 조각이 있으면 새로 그리지 않는다. 프레임 → 코드 맵은 docs/car-frames.md.
 */

/**
 * 시안 글자 스타일(Pretendard). Figma 자간은 퍼센트라 em으로 옮긴다(Title -1.5% = -0.6px, Status -2%, Headline -1%).
 * 줄 높이 안에서 글자를 가운데에 두고 첫·끝 줄을 깎지 않는다(Figma와 같게. Compose 기본은 위아래를 깎아 3–5px 밀림).
 */
object CarText {
    private val Lines = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None)
    val Status = TextStyle(fontFamily = Pretendard, fontWeight = FontWeight.Bold, fontSize = 56.sp, lineHeight = 64.sp, letterSpacing = (-0.02).em, lineHeightStyle = Lines) // Car/Status 56
    val Title = TextStyle(fontFamily = Pretendard, fontWeight = FontWeight.Bold, fontSize = 40.sp, lineHeight = 50.sp, letterSpacing = (-0.015).em, lineHeightStyle = Lines) // Car/Title 40
    val Headline = TextStyle(fontFamily = Pretendard, fontWeight = FontWeight.Bold, fontSize = 32.sp, lineHeight = 42.sp, letterSpacing = (-0.01).em, lineHeightStyle = Lines) // Car/Headline 32
    val Body = TextStyle(fontFamily = Pretendard, fontWeight = FontWeight.Medium, fontSize = 28.sp, lineHeight = 40.sp, lineHeightStyle = Lines) // Car/Body 28
    val Label = TextStyle(fontFamily = Pretendard, fontWeight = FontWeight.Medium, fontSize = 24.sp, lineHeight = 32.sp, lineHeightStyle = Lines) // Car/Label 24
}

/** 시안 모서리: radius/car-card 32, radius/car-ctl 24, 위 탭 바 20·칸 16, 캐릭터 칸 48, 공유 시트 28, 링크 카드 16. */
object CarShape {
    val Card = RoundedCornerShape(32.dp)
    val Ctl = RoundedCornerShape(24.dp)
    val TabBar = RoundedCornerShape(20.dp)
    val Tab = RoundedCornerShape(16.dp)
    val Face = RoundedCornerShape(48.dp)
    val Sheet = RoundedCornerShape(28.dp)
}

/** 시안 tint-1–5(어두운 값): 사람마다 다른 장면 카드 바탕. Material 역할에 없는 색이라 여기서만 정의한다(design.md 3절). */
val CarTints = listOf(Color(0xFF2A2840), Color(0xFF3A3020), Color(0xFF3A2530), Color(0xFF1E3A2E), Color(0xFF1F2F40))

/**
 * 시안의 밝은 '종이' 표지(Archive / galleryCar·완성 표지·온보딩 보관함 예시): design.md 3절의 밝은 tint-1–5와 밝은 ink·ink-2.
 * 어두운 차 화면 위에 올리는 표지 그림에만 쓴다(화면 바탕·글자는 Material 역할).
 */
object CarPaper {
    val Tints = listOf(Color(0xFFECEAFB), Color(0xFFFCF0D9), Color(0xFFFBE7EE), Color(0xFFE4F4EC), Color(0xFFE5F0FB))
    val Ink = Color(0xFF28221B)
    val Ink2 = Color(0xFF5A5044)
}

/**
 * 시안 C17 계열 아래 녹음 막대('기록 컨트롤 / 상태와 동작' 2014:943)와 좌석 지도의 말하는 사람 고리('화자 링 / 민트' 2209:5864)에만 있는 색.
 * 시안이 변수 없이 적은 값이라 Material 역할에 없다.
 */
object CarRecord {
    val Timer = Color(0xFFF23424) // 기록 중 경과 시간 '19:11'
    val WaveBg = Color(0xFF110C10) // '녹화 파형' 292×84 칸 바탕: 시안 화면에 보이는 색(그림 2196:5878 원본은 #231D1F, 프레임 안에서 18 어둡게 그려진다)
    val Edge = Color.Black // 막대 테두리 1
    val StopRing = Color.White // ■ 정지 단추 테두리 2
    val Ring = listOf(0f to Color(0xFFE8FFF5), 0.33f to Color(0xFF7DFFC9), 0.72f to Color(0xFF30E094), 1f to Color(0xFF1A8563)) // 고리 4.5 그러데이션
    val RingGlow = Color(0xFF38E0A1).copy(alpha = 0.38f) // 고리 둘레 빛(그림자 흐림 4)
    val RingInner = Color(0xFFD9FFED).copy(alpha = 0.64f) // 안쪽 하이라이트 1.2
}

/**
 * 시안의 '내 얼굴' 프로필 메뉴(2200:5854)와 로그아웃 확인(2220:5866)에만 있는 색. 시안이 변수 없이 적은 값이라 Material 역할에 없다.
 * 바깥 어둡게는 검정 56%(드롭다운)·62%(확인).
 */
object CarMenu {
    val Surface = Color(0xFF262824) // 드롭다운·확인 바탕
    val Line = Color(0xFF7A9C87) // 테두리 2
    val CountWide = Color(0xFFADC2B8) // 주차 1682 메뉴(2257:5886) 동승자 수
    val InkWide = Color(0xFFF5F2ED) // 주차 1682 메뉴(2257:5902) '갤러리 바로가기'
    val Ink = Color(0xFFF5F2ED) // 확인 제목·취소, '갤러리 바로가기' 글
    val Ink2 = Color(0xFFB8BAB0) // 확인 설명
    val Count = Color(0xFFADC2B8) // 동승 그룹 인원
    val Cancel = Color(0xFF383833) // 확인의 취소
    val Confirm = Color.White.copy(alpha = 0.12f) // 확인의 로그아웃 바탕
    val ConfirmInk = Color.White.copy(alpha = 0.92f) // 메뉴·확인의 '로그아웃' 글
    val Scrim = Color.Black.copy(alpha = 0.56f)
    val ConfirmScrim = Color.Black.copy(alpha = 0.62f)
}

/** 단추 종류: 큰 단추(accent 바탕·on-accent 글), 보조(surface-2·ink), 멈춤(rec-soft·rec, 기록 중지). */
enum class CarButtonKind { Primary, Secondary, Stop }

/** 시안 단추(Button/car/primary 등): 높이 96(초대·시트 안 80, 주행 큰 단추 132, 대화 기록 112), 모서리 24, Car/Headline 32(대화 기록은 36 SemiBold, [style]). 꺼진 큰 단추는 시안(C23)대로 같은 색 45%, 꺼진 보조 단추는 surface-2·ink-2. */
@Composable
fun CarButton(
    label: String, modifier: Modifier = Modifier.fillMaxWidth(), kind: CarButtonKind = CarButtonKind.Primary, enabled: Boolean = true,
    height: Dp = 96.dp, style: TextStyle = CarText.Headline, onClick: () -> Unit,
) {
    val c = MaterialTheme.colorScheme
    val (bg, fg) = when {
        kind == CarButtonKind.Primary -> c.primary to c.onPrimary
        !enabled -> c.surfaceVariant to c.onSurfaceVariant
        kind == CarButtonKind.Stop -> c.errorContainer to c.error
        else -> c.surfaceVariant to c.onSurface
    }
    Surface(onClick = onClick, enabled = enabled, modifier = modifier.height(height).alpha(if (!enabled && kind == CarButtonKind.Primary) 0.45f else 1f),
        shape = CarShape.Ctl, color = bg) {
        Box(contentAlignment = Alignment.Center) { Text(label, color = fg, style = style, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center) }
    }
}

/** 화면 제목 묶음: Car/Title 40 · 간격 12 · Car/Label 24(ink-2). */
@Composable
fun TitleBlock(title: String, sub: String, modifier: Modifier = Modifier) = Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
    Text(title, style = CarText.Title, maxLines = 2, overflow = TextOverflow.Ellipsis)
    if (sub.isNotEmpty()) Text(sub, style = CarText.Label, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/**
 * 주차 화면 틀(시안 C01–C16·C20·C22–C38): 여백 40, 머리 줄 80('가치타' · '주차 중  P'), 위 탭(있으면, 76), 칸 간격 24, 본문, 아래 단추 줄(간격 24).
 * [tab]이 null이면 탭을 그리지 않는다. 머리 줄 오른쪽 위 '내 얼굴'은 TripHeader가 늘 그린다('주차 중  P' 다음).
 */
@Composable
fun ParkedFrame(
    tab: Int? = null, onTab: (Int) -> Unit = {}, tabEnabled: (Int) -> Boolean = { true }, gear: String? = "P", online: Boolean = true,
    bottom: (@Composable RowScope.() -> Unit)? = null, overlay: @Composable BoxScope.() -> Unit = {},
    body: @Composable ColumnScope.() -> Unit,
) = Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
    Column(Modifier.fillMaxSize().padding(Shell.PARKED.padH), verticalArrangement = Arrangement.spacedBy(Shell.PARKED.gap)) {
        TripHeader(Shell.PARKED, gear, online, listening = false)
        if (tab != null) TripTabs(TRIP_TABS, tab, tabEnabled, onTab)
        Column(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Shell.PARKED.gap), content = body)
        if (bottom != null) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(24.dp), content = bottom)
    }
    overlay()
}

/** 위 탭 세 칸(시안 '상위 탭'). */
val TRIP_TABS = listOf("함께 타는 중", "대화 기록", "콘텐츠 기록")

/** 정보 카드(시안 카드: surface 또는 accent-soft, 모서리 32, 여백 26, 간격 24): 사진 또는 캐릭터 92(있으면) · 제목 Headline 32(ink) / 설명 Label 24(ink-2). */
@Composable
fun InfoCard(
    title: String, detail: String, modifier: Modifier = Modifier.fillMaxWidth(), soft: Boolean = false, face: Int? = null, photo: Bitmap? = null,
    onClick: (() -> Unit)? = null,
) {
    val c = MaterialTheme.colorScheme
    Surface(modifier.clip(CarShape.Card).then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier), CarShape.Card,
        color = if (soft) c.primaryContainer else c.surface) {
        Row(Modifier.padding(26.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            if (photo != null) Image(photo.asImageBitmap(), null, Modifier.size(92.dp).clip(CarShape.Face), contentScale = ContentScale.Crop)
            else if (face != null) CharAvatar(face, 92.dp, CarShape.Face)
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(title, style = CarText.Headline, color = c.onSurface) // accent-soft 위에서도 ink(시안)
                if (detail.isNotEmpty()) Text(detail, style = CarText.Label, color = c.onSurfaceVariant)
            }
        }
    }
}

/** 입력란(시안: 라벨 Label 24 ink-2, 칸 surface-2 · 모서리 32 · 여백 22 · Body 28, 높이 84). */
@Composable
fun CarField(label: String, value: String, change: (String) -> Unit, type: KeyboardType, secret: Boolean = false, placeholder: String = "") {
    val c = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(24.dp)) { // 시안: 라벨과 칸 사이 24
        Text(label, style = CarText.Label, color = c.onSurfaceVariant)
        BasicTextField(value, change, Modifier.fillMaxWidth().height(84.dp), singleLine = true, textStyle = CarText.Body.copy(color = c.onSurface),
            cursorBrush = SolidColor(c.primary), keyboardOptions = KeyboardOptions(keyboardType = type),
            visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
            decorationBox = { inner ->
                Box(Modifier.fillMaxSize().clip(CarShape.Card).background(c.surfaceVariant).padding(horizontal = 22.dp), contentAlignment = Alignment.CenterStart) {
                    if (value.isEmpty()) Text(placeholder, style = CarText.Body, color = c.onSurfaceVariant.copy(alpha = 0.6f))
                    inner()
                }
            })
    }
}

/**
 * 알림(시안 '복사했어요' 2047:2276: 화면 가운데 겹침, accent-soft, 모서리 24, 800 폭, 여백 28/24, Title 40, 1.5초 뒤 닫힘). 틀의 overlay에 둔다.
 * 원본에 없는 오류·안내 글(서버·마이크·좌석)도 따로 화면을 두지 않고 이 알림으로만 보인다 — 읽을 틈을 두려고 그런 글은 3초.
 */
@Composable
fun BoxScope.CarToast(text: String) {
    if (text.isEmpty()) return
    Surface(Modifier.align(Alignment.Center), CarShape.Ctl, color = MaterialTheme.colorScheme.primaryContainer) {
        Text(text, Modifier.padding(horizontal = 28.dp, vertical = 24.dp).width(744.dp), style = CarText.Title, color = MaterialTheme.colorScheme.onSurface)
    }
}

/** 알림이 떠 있는 시간: 시안의 '복사했어요'는 1.5초, 원본에 없는 오류·안내 글은 3초. */
fun toastMs(text: String) = if (text == "복사했어요") 1500L else 3000L

/** 시트(시안 공유 시트 2047:2279: surface, 800 폭, 모서리 28, 여백 32, 간격 20). */
@Composable
fun CarSheet(onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) = Dialog(onDismiss, DialogProperties(usePlatformDefaultWidth = false)) {
    Surface(Modifier.width(800.dp), CarShape.Sheet, color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.padding(32.dp), verticalArrangement = Arrangement.spacedBy(20.dp), content = content)
    }
}
