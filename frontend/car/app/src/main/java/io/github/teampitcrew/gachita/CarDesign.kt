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

/** 시안 글자 스타일(Pretendard). Figma 자간 -2·-1은 퍼센트라 em으로 옮긴다(-2% = -0.02em). */
object CarText {
    val Status = TextStyle(fontFamily = Pretendard, fontWeight = FontWeight.Bold, fontSize = 56.sp, lineHeight = 64.sp, letterSpacing = (-0.02).em) // Car/Status 56
    val Title = TextStyle(fontFamily = Pretendard, fontWeight = FontWeight.Bold, fontSize = 40.sp, lineHeight = 50.sp, letterSpacing = (-0.02).em) // Car/Title 40
    val Headline = TextStyle(fontFamily = Pretendard, fontWeight = FontWeight.Bold, fontSize = 32.sp, lineHeight = 42.sp, letterSpacing = (-0.01).em) // Car/Headline 32
    val Body = TextStyle(fontFamily = Pretendard, fontWeight = FontWeight.Medium, fontSize = 28.sp, lineHeight = 40.sp) // Car/Body 28
    val Label = TextStyle(fontFamily = Pretendard, fontWeight = FontWeight.Medium, fontSize = 24.sp, lineHeight = 32.sp) // Car/Label 24, 차의 가장 작은 글자
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

/** 단추 종류: 큰 단추(accent 바탕·on-accent 글), 보조(surface-2·ink), 멈춤(rec-soft·rec, 기록 중지). */
enum class CarButtonKind { Primary, Secondary, Stop }

/** 시안 단추(Button/car/primary 등): 높이 96(초대·시트 안 80, 주행 큰 단추 132), 모서리 24, Car/Headline 32. 꺼진 큰 단추는 시안(C23)대로 같은 색 45%, 꺼진 보조 단추는 surface-2·ink-2. */
@Composable
fun CarButton(
    label: String, modifier: Modifier = Modifier.fillMaxWidth(), kind: CarButtonKind = CarButtonKind.Primary, enabled: Boolean = true,
    height: Dp = 96.dp, onClick: () -> Unit,
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
        Box(contentAlignment = Alignment.Center) { Text(label, color = fg, style = CarText.Headline, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center) }
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
 * [tab]이 null이면 탭을 그리지 않는다. [headerExtra]는 머리 줄 오른쪽 끝(창 크기 안내 등 유지 단추).
 */
@Composable
fun ParkedFrame(
    tab: Int? = null, onTab: (Int) -> Unit = {}, tabEnabled: (Int) -> Boolean = { true }, gear: String? = "P", online: Boolean = true,
    headerExtra: @Composable () -> Unit = {}, bottom: (@Composable RowScope.() -> Unit)? = null, overlay: @Composable BoxScope.() -> Unit = {},
    body: @Composable ColumnScope.() -> Unit,
) = Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
    Column(Modifier.fillMaxSize().padding(Shell.PARKED.padH), verticalArrangement = Arrangement.spacedBy(Shell.PARKED.gap)) {
        TripHeader(Shell.PARKED, gear, online, listening = false, extra = headerExtra)
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

/** 오른쪽 '함께 타는 가족' 카드(시안 590 × 칸 높이, 여백 32, 간격 24): 제목 Title 40 · 설명 Body 28 · 캐릭터 110(간격 18) · 'N명' · 설명. */
@Composable
fun FamilyCard(faces: List<Int>, count: Int, modifier: Modifier = Modifier.width(590.dp)) {
    val c = MaterialTheme.colorScheme
    Surface(modifier, CarShape.Card, color = c.surface) {
        Column(Modifier.padding(32.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            Text("차가 바뀌어도\n우리는 그대로", style = CarText.Title)
            Text("한 번 만든 가족 프로필로\n차량과 폰에서 이어가세요.", style = CarText.Body, color = c.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(18.dp)) { faces.take(4).forEach { CharAvatar(it, 110.dp, CarShape.Face) } }
            Text("우리 가족  ${count}명", style = CarText.Headline)
            Text("프로필과 목소리, 가족 그룹을\n같은 계정으로 함께 사용", style = CarText.Label, color = c.onSurfaceVariant)
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

/** 알림(시안 '복사했어요' 2047:2276: accent-soft, 모서리 24, 800 폭, 여백 28/24, Title 40). 틀의 overlay에 둔다. */
@Composable
fun BoxScope.CarToast(text: String) {
    if (text.isEmpty()) return
    Surface(Modifier.align(Alignment.BottomCenter).padding(bottom = 160.dp), CarShape.Ctl, color = MaterialTheme.colorScheme.primaryContainer) {
        Text(text, Modifier.padding(horizontal = 28.dp, vertical = 24.dp).width(744.dp), style = CarText.Title, color = MaterialTheme.colorScheme.onSurface)
    }
}

/** 시트(시안 공유 시트 2047:2279: surface, 800 폭, 모서리 28, 여백 32, 간격 20). */
@Composable
fun CarSheet(onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) = Dialog(onDismiss, DialogProperties(usePlatformDefaultWidth = false)) {
    Surface(Modifier.width(800.dp), CarShape.Sheet, color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.padding(32.dp), verticalArrangement = Arrangement.spacedBy(20.dp), content = content)
    }
}
