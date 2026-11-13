package io.github.teampitcrew.gachita

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.util.Locale

// Theme.kt의 밤 토큰. 영상 무대는 낮 모드에서도 같은 따뜻한 먹색을 유지합니다.
private object ShortStageColors {
    val background = Color(0xFF12110F)
    val surface = Color(0xFF1C1A17)
    val raised = Color(0xFF26231F)
    val ink = Color(0xFFF4F1EC)
    val secondary = Color(0xFFB5ADA2)
    val mint = Color(0xFF6FD3A6)
    val mintSoft = Color(0xFF1C3A2D)
    val mintInk = Color(0xFF7FDDB2)
}

/**
 * 서버가 만든 장면 구성만 표시합니다. 재생·음량·권한·주행 제한은 호출자가 관리합니다.
 * 이 구성의 음성 클립과 자막을 MP4가 생성된 것처럼 표시하지 않습니다.
 * 창 크기는 OS가 정하고, 9:16 무대는 주어진 가로·세로 공간 안에 맞춥니다.
 * 화자 반응이 움직이므로 주행 제한이 풀린 때만 호출합니다(MainActivity.Takeover).
 */
@Composable
fun GeneratedShortStage(
    short: Short,
    index: Int,
    seconds: Double,
    paused: Boolean,
    muted: Boolean,
    people: List<Person>,
    modifier: Modifier = Modifier,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
    onPause: () -> Unit,
    onMute: () -> Unit,
    onClose: () -> Unit,
    controlsEnabled: Boolean = true,
) {
    val colors = ShortStageColors
    val scene = short.scenes.getOrNull(index)
    val elapsed = seconds.takeIf { it.isFinite() }?.coerceAtLeast(0.0) ?: 0.0
    val duration = scene?.seconds?.takeIf { it.isFinite() && it > 0.0 } ?: 0.0
    val progress = if (duration > 0.0) (elapsed / duration).coerceIn(0.0, 1.0).toFloat() else 0f
    val speakingCue = scene?.let { cueAt(it.cues, elapsed) }
    val cue = scene?.let { speakingCue ?: it.cues.lastOrNull { c -> elapsed >= c.start } ?: if (paused) it.cues.firstOrNull() else null }
    val cast = shortSceneCast(scene, cue, people)
    val activeSpeaker = speakingCue?.takeUnless { paused }?.let { sceneActor(it.who, people).key }
    val canPrevious = controlsEnabled && scene != null && index > 0
    val canNext = controlsEnabled && scene != null && index < short.scenes.lastIndex
    val previous by rememberUpdatedState(onPrevious)
    val next by rememberUpdatedState(onNext)
    val swipeDistance = with(LocalDensity.current) { 56.dp.toPx() }

    MaterialTheme(colorScheme = MaterialTheme.colorScheme.copy(
        background = colors.background, surface = colors.surface, onSurface = colors.ink,
        primary = colors.mint, onPrimary = colors.background,
        primaryContainer = colors.mintSoft, onPrimaryContainer = colors.mintInk,
    )) {
        BoxWithConstraints(modifier.clip(RoundedCornerShape(28.dp)).background(colors.background)) {
            val compact = maxWidth < 560.dp || maxHeight < 700.dp
            val gutter = if (compact) 12.dp else 24.dp
            val gap = if (compact) 10.dp else 16.dp
            Column(Modifier.fillMaxSize().padding(gutter), verticalArrangement = Arrangement.spacedBy(gap)) {
                Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(short.title.ifBlank { "우리의 쇼츠" }, color = colors.ink,
                            fontSize = if (compact) 22.sp else 28.sp, fontWeight = FontWeight.Bold,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(if (scene == null) "재생할 장면이 없어요" else "${index + 1} / ${short.scenes.size} 장면",
                            color = colors.secondary, fontSize = if (compact) 16.sp else 20.sp)
                    }
                    ShortStageButton("닫기", onClose, compact = compact)
                }

                BoxWithConstraints(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    val panelWidth = minOf(maxWidth, maxHeight * (9f / 16f))
                    val panelHeight = panelWidth * (16f / 9f)
                    val smallPanel = panelWidth < 260.dp
                    val titleSize = if (smallPanel) 18.sp else if (panelWidth < 360.dp) 26.sp else 32.sp
                    val captionSize = if (smallPanel) 19.sp else if (panelWidth < 360.dp) 28.sp else 34.sp
                    val panelInset = if (smallPanel) 8.dp else 16.dp
                    val gestures = Modifier
                        .semantics {
                            customActions = buildList {
                                if (canPrevious) add(CustomAccessibilityAction("이전 쇼츠") { previous(); true })
                                if (canNext) add(CustomAccessibilityAction("다음 쇼츠") { next(); true })
                            }
                        }
                        .pointerInput(index, short.scenes.size, swipeDistance, controlsEnabled) {
                            var dragged = 0f
                            detectVerticalDragGestures(
                                onDragStart = { dragged = 0f },
                                onDragCancel = { dragged = 0f },
                                onDragEnd = {
                                    if (dragged < -swipeDistance && canNext) next()
                                    else if (dragged > swipeDistance && canPrevious) previous()
                                    dragged = 0f
                                },
                                onVerticalDrag = { change, amount -> change.consume(); dragged += amount },
                            )
                        }
                    Surface(Modifier.size(panelWidth, panelHeight).then(gestures), shape = RoundedCornerShape(24.dp), color = Color(0xFF090B0A)) {
                        Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
                            Box(Modifier.weight(0.17f).fillMaxWidth().padding(horizontal = panelInset, vertical = 4.dp), contentAlignment = Alignment.Center) {
                                Text(scene?.label?.ifBlank { "함께 남긴 장면" } ?: "아직 남긴 장면이 없어요",
                                    color = colors.ink, fontSize = titleSize, lineHeight = titleSize * 1.2f,
                                    fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
                            }

                            ShortCarScene(cast, activeSpeaker, elapsed,
                                Modifier.weight(0.40f).fillMaxWidth().padding(horizontal = if (smallPanel) 4.dp else 8.dp))

                            Column(Modifier.weight(0.30f).fillMaxWidth().padding(horizontal = panelInset, vertical = 4.dp),
                                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                                Text(cue?.who?.ifBlank { "화자 미확인" } ?: "",
                                    color = colors.mintInk, fontSize = if (smallPanel) 12.sp else 18.sp,
                                    fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                    textAlign = TextAlign.Center)
                                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                                    Text(cue?.text.orEmpty(), Modifier.fillMaxWidth(), color = colors.ink,
                                        fontSize = captionSize, lineHeight = captionSize * 1.25f,
                                        fontWeight = FontWeight.Bold, textAlign = TextAlign.Center,
                                        maxLines = if (smallPanel) 3 else 4, overflow = TextOverflow.Ellipsis)
                                }
                            }

                            Column(Modifier.weight(0.13f).fillMaxWidth().padding(horizontal = panelInset),
                                verticalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterVertically)) {
                                Text("함께 남긴 원래 목소리", Modifier.fillMaxWidth(), color = colors.secondary,
                                    fontSize = if (smallPanel) 10.sp else 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                    textAlign = TextAlign.Center)
                                LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth(), color = colors.mint, trackColor = colors.raised)
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                    Text(shortClock(elapsed.coerceAtMost(duration)), color = colors.secondary, fontSize = if (smallPanel) 10.sp else 14.sp)
                                    Text(shortClock(duration), color = colors.secondary, fontSize = if (smallPanel) 10.sp else 14.sp)
                                }
                            }
                        }
                    }
                }

                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(if (compact) 6.dp else 12.dp)) {
                    ShortStageButton("이전", onPrevious, Modifier.weight(1f), enabled = canPrevious, compact = compact)
                    ShortStageButton(if (paused) "재생" else "일시정지", onPause, Modifier.weight(1f), enabled = controlsEnabled && scene != null, compact = compact, primary = true)
                    ShortStageButton(if (muted) "소리 켜기" else "음소거", onMute, Modifier.weight(1f), enabled = controlsEnabled && scene != null, compact = compact)
                    ShortStageButton("다음", onNext, Modifier.weight(1f), enabled = canNext, compact = compact)
                }
            }
        }
    }
}

private data class ShortSceneActor(val key: String, val label: String, val character: Int?)

private fun sceneActor(who: String, people: List<Person>): ShortSceneActor {
    // 같은 이름이 여러 명이거나 좌석만 알려진 큐에는 사람의 캐릭터를 임의로 붙이지 않습니다.
    val person = people.singleOrNull { it.name == who && who.isNotBlank() }
    val seat = person?.let { p -> Seat.entries.firstOrNull { it.name == p.seat } }
    return ShortSceneActor(person?.id ?: "unknown:$who", who.ifBlank { "화자 미확인" }, seat?.ordinal)
}

private fun shortSceneCast(scene: Scene?, cue: Cue?, people: List<Person>): List<ShortSceneActor> {
    // 뒤에 말할 사람도 실제 장면의 화자이므로 첫 화면부터 함께 둡니다. 참가자 명단으로 추측하지 않습니다.
    val cast = scene?.cues.orEmpty().map { sceneActor(it.who, people) }.filter { it.character != null }
        .distinctBy { it.key }.take(2).toMutableList()
    while (cast.size < 2) cast += ShortSceneActor("unidentified:${cast.size}", "화자 미확인", null)
    // 처음 등장한 두 사람의 좌우는 유지하고, 세 번째 화자가 말할 때만 오른쪽을 바꿉니다.
    cue?.let { sceneActor(it.who, people) }?.let { current -> if (cast.none { it.key == current.key }) cast[1] = current }
    return cast
}

/** 참조 영상의 이미지를 쓰지 않고 창·시트·대시보드를 직접 그린 대화 장면입니다. 좌우는 실제 좌석 배정이 아닙니다. */
@Composable
private fun ShortCarScene(cast: List<ShortSceneActor>, activeSpeaker: String?, elapsed: Double, modifier: Modifier) {
    BoxWithConstraints(modifier.clip(RoundedCornerShape(18.dp))) {
        val sceneWidth = maxWidth
        val sceneHeight = maxHeight
        Canvas(Modifier.fillMaxSize()) {
            val w = size.width; val h = size.height
            drawRect(Color(0xFF23362F))
            // 정차한 차창 밖의 하늘과 낮은 산. 배경을 움직여 주행 중인 것으로 연출하지 않습니다.
            val window = Path().apply {
                moveTo(w * 0.11f, h * 0.08f); lineTo(w * 0.89f, h * 0.08f)
                lineTo(w * 0.96f, h * 0.39f); lineTo(w * 0.04f, h * 0.39f); close()
            }
            drawPath(window, Color(0xFFA8C7B7))
            drawPath(Path().apply {
                moveTo(w * 0.06f, h * 0.36f); lineTo(w * 0.27f, h * 0.23f)
                lineTo(w * 0.48f, h * 0.34f); lineTo(w * 0.72f, h * 0.20f)
                lineTo(w * 0.94f, h * 0.36f); lineTo(w * 0.95f, h * 0.40f)
                lineTo(w * 0.05f, h * 0.40f); close()
            }, Color(0xFF6F9584))
            drawRoundRect(Color(0xFF18251F), Offset(w * 0.43f, h * 0.08f), Size(w * 0.14f, h * 0.06f), CornerRadius(h * 0.025f))
            // 캐릭터의 전신이 모두 보이도록 시트와 대시보드는 이미지 뒤에만 둡니다.
            for (left in listOf(0.07f, 0.55f)) {
                drawRoundRect(Color(0xFF6B7569), Offset(w * (left + 0.08f), h * 0.27f), Size(w * 0.22f, h * 0.19f), CornerRadius(w * 0.055f))
                drawRoundRect(Color(0xFF4A584D), Offset(w * left, h * 0.40f), Size(w * 0.38f, h * 0.53f), CornerRadius(w * 0.08f))
                drawRoundRect(Color(0xFF607061), Offset(w * (left + 0.025f), h * 0.44f), Size(w * 0.33f, h * 0.44f), CornerRadius(w * 0.065f))
            }
            drawRoundRect(Color(0xFF1B2822), Offset(0f, h * 0.90f), Size(w, h * 0.15f), CornerRadius(h * 0.05f))
            drawLine(Color(0xFF86AA95), Offset(w * 0.06f, h * 0.92f), Offset(w * 0.94f, h * 0.92f), h * 0.009f, StrokeCap.Round)
        }
        Row(Modifier.fillMaxSize().padding(horizontal = sceneWidth * 0.045f, vertical = sceneHeight * 0.025f),
            horizontalArrangement = Arrangement.spacedBy(sceneWidth * 0.035f)) {
            cast.forEach { actor ->
                ShortScenePerson(actor, actor.key == activeSpeaker, elapsed,
                    Modifier.weight(1f).fillMaxSize().padding(top = sceneHeight * 0.16f))
            }
        }
    }
}

@Composable
private fun ShortScenePerson(actor: ShortSceneActor, speaking: Boolean, elapsed: Double, modifier: Modifier) {
    val colors = ShortStageColors
    val emphasis by animateFloatAsState(if (speaking) 1f else 0f, tween(160), label = "short-speaker-emphasis")
    val beat by animateFloatAsState(if (speaking && (elapsed * 5).toLong() % 2L == 0L) 1f else 0f, tween(150), label = "short-speaker-beat")
    val bouncePx = with(LocalDensity.current) { 3.dp.toPx() }
    BoxWithConstraints(modifier.semantics { contentDescription = if (speaking) "${actor.label}, 말하는 중" else actor.label }) {
        val portrait = minOf(maxWidth * 0.92f, maxHeight * 0.92f)
        Canvas(Modifier.fillMaxSize()) {
            drawOval(colors.mint.copy(alpha = 0.12f + emphasis * 0.24f),
                Offset(size.width * 0.1f, size.height * 0.84f), Size(size.width * 0.8f, size.height * 0.12f))
            if (speaking) {
                for (i in 0..2) {
                    val x = size.width * (0.79f + i * 0.065f)
                    val y = size.height * (0.25f - i * 0.035f)
                    drawLine(colors.mint, Offset(x, y), Offset(x + size.width * 0.035f, y - size.height * (0.045f + beat * 0.015f)),
                        size.width * 0.018f, StrokeCap.Round)
                }
            }
        }
        Box(Modifier.align(Alignment.Center).graphicsLayer {
            translationY = -bouncePx * beat
            scaleX = 1f + emphasis * 0.025f; scaleY = 1f + emphasis * 0.025f
        }) {
            if (actor.character != null) Character(actor.character, portrait, ring = false)
            else Mascot(listening = speaking, size = portrait * 0.70f)
        }
    }
}

@Composable
private fun ShortStageButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    compact: Boolean,
    primary: Boolean = false,
) {
    val colors = ShortStageColors
    Button(onClick, modifier.heightIn(min = 56.dp), enabled = enabled,
        shape = RoundedCornerShape(16.dp), contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp, vertical = 12.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = if (primary) colors.mint else colors.raised,
            contentColor = if (primary) colors.background else colors.ink,
            disabledContainerColor = colors.surface, disabledContentColor = colors.secondary.copy(alpha = 0.5f),
        )) {
        Text(label, fontSize = if (compact) 16.sp else 20.sp, maxLines = 1, fontWeight = FontWeight.SemiBold)
    }
}

private fun shortClock(seconds: Double): String {
    val total = seconds.toInt().coerceAtLeast(0)
    return String.format(Locale.ROOT, "%d:%02d", total / 60, total % 60)
}
