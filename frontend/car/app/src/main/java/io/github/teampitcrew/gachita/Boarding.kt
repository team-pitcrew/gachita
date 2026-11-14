package io.github.teampitcrew.gachita

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import kotlinx.coroutines.delay
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.text.font.FontFamily
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow

// 동승자의 녹음 동의는 각자 휴대폰에서 QR로 받는다(11/15 오너). 차에는 남의 동의를 켜는 화면이 없다.
internal enum class BoardingPage { HIDDEN, PEOPLE, QR, SEAT }
internal data class BoardingState(
    val page: BoardingPage = BoardingPage.HIDDEN,
    val personId: String? = null,
    val seat: Seat? = null,
    val note: String = "",
    val invite: BoardingInvite? = null,
    val issuing: Boolean = false,
    val joinedBefore: Set<String> = emptySet(),
)
internal sealed interface BoardingAction {
    data object Close : BoardingAction
    data object Back : BoardingAction
    data object Invite : BoardingAction
    data object ExpireInvite : BoardingAction
    data class PickSeat(val seat: Seat) : BoardingAction
    data class Move(val person: Person) : BoardingAction
}

/** API 거절을 성공으로 표시하지 않는다. 자리 충돌은 QR을 유지하므로 빈자리를 다시 고를 수 있다. */
internal fun boardingFailure(error: Throwable): String = when {
    error is ApiError && error.status in setOf(404, 410) -> "초대 시간이 끝났거나 더 이상 쓸 수 없어요. 차에서 새 참석 QR을 만들어 주세요."
    error is ApiError && error.status in setOf(401, 403) -> "운전석 참가자의 연결을 확인해 주세요. 이 차에서 만든 여행에서 QR을 열 수 있어요."
    error is ApiError && error.status == 409 -> "그 자리에 다른 사람이 탔거나 이미 연결된 사람이에요. 현재 탑승자를 확인하고 빈자리를 다시 골라 주세요."
    else -> "연결 완료를 확인하지 못했어요. 동승자 설정에서 탑승자를 확인한 뒤 다시 시도해 주세요."
}

internal fun selectableSeat(trip: Trip, seats: List<String>, seat: Seat?, moving: String? = null): Boolean =
    seat != null && seat in seatRows(seats).flatten() && trip.people.none { it.seat == seat.name && it.id != moving }

/**
 * 동승자 설정(여행 중, 주차): 원본 C16B 좌석 배정 → C16C '누가 앉나요?' → 자리 옮기기, 그리고 C16 guestInvite 모양의 참석 QR(휴대폰으로 참여·녹음 동의).
 * 여행 중 자리는 서버가 한 사람씩 옮겨 빈자리로만 옮긴다(맞바꾸기 없음). 머리 줄·탭은 여행 화면이 그린다.
 */
@Composable
internal fun BoardingPanel(
    state: BoardingState, session: Session, seats: List<String>,
    modifier: Modifier = Modifier, onAction: (BoardingAction) -> Unit,
) {
    val trip = session.trip ?: return
    val c = MaterialTheme.colorScheme
    val members = trip.people.map { GroupMember(it.id, it.name, it.character, false, it.consent, "", it.seat.takeIf { s -> s.isNotBlank() }) }
    val canMove = !session.busy && session.online && session.gear == "P"
    val canInvite = canMove && freeSeats(trip, seats).isNotEmpty() && trip.status in setOf("boarding", "parked") &&
        trip.people.any { it.seat == Seat.ROW_1_LEFT.name && it.id in session.ours }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(Shell.PARKED.gap)) {
        when (state.page) {
            BoardingPage.QR -> BoardingQr(state, session, onAction, Modifier.weight(1f))
            BoardingPage.SEAT -> { // C16C
                TitleBlock("누가 앉나요?", "선택한 좌석에 앉을 사람을 골라 주세요.")
                Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(24.dp)) {
                    state.seat?.let { seat -> MemberPicker(members, seat.name) { m -> trip.people.firstOrNull { it.id == m.profileId }?.let { onAction(BoardingAction.Move(it)) } } }
                }
            }
            else -> { // C16B
                TitleBlock("좌석 배정", "좌석을 누르고 앉을 사람을 선택해 주세요.")
                Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                    Column(Modifier.widthIn(max = 1100.dp).fillMaxHeight().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(24.dp)) {
                        SeatAssign(members, swaps = false) { name -> Seat.entries.firstOrNull { it.name == name }?.let { onAction(BoardingAction.PickSeat(it)) } }
                    }
                }
            }
        }
        val note = state.note.ifBlank { if (state.page == BoardingPage.PEOPLE && !canMove) "주차 중에만 자리를 바꾸거나 새로 연결할 수 있어요." else "" }
        if (state.page != BoardingPage.QR && note.isNotBlank()) Text(note, style = CarText.Label, color = if (state.note.isNotBlank()) c.error else c.onSurfaceVariant)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            when (state.page) {
                // C16 guestInvite '그룹으로 돌아가기'(primary) · C16C '좌석 배정으로'(secondary) 자리. 여행에서는 둘 다 C16B로 돌아간다.
                BoardingPage.QR -> CarButton("좌석 배정으로", Modifier.weight(1f), enabled = !session.busy) { onAction(BoardingAction.Back) }
                BoardingPage.SEAT -> CarButton("좌석 배정으로", Modifier.weight(1f), CarButtonKind.Secondary, enabled = !session.busy) { onAction(BoardingAction.Back) }
                else -> {
                    CarButton("닫기", Modifier.weight(1f), CarButtonKind.Secondary) { onAction(BoardingAction.Close) }
                    // 새 동승자는 휴대폰으로 QR을 읽어 참여하고 그 휴대폰에서 녹음에 동의한다(차에는 남의 동의를 켜는 화면이 없다).
                    CarButton("참석 QR 띄우기", Modifier.weight(1f), enabled = canInvite) { onAction(BoardingAction.Invite) }
                }
            }
        }
    }
}

/**
 * 참석 QR(원본 C16 guestInvite 2005:3229 · C16I 모양): 왼쪽 카드 650(남은 시간 · QR 320 · 안내), 오른쪽 '초대 링크' 카드 · 공유 시트(2047:2296) ·
 * 링크 복사·열기. 여행 초대는 사람이 입력하는 코드가 없어 코드 자리에 남은 시간을 둔다. QR은 만료 즉시 사라지고, 참여 결과는 실제 여행 조회로만 적는다.
 */
/** 원본 C16 guestInvite의 40 Bold 자간 −0.8px(−2%): '초대 링크'·링크 카드 제목·코드 자리. */
private val Title2 = CarText.Title.copy(letterSpacing = (-0.02).em)

@Composable
private fun BoardingQr(state: BoardingState, session: Session, onAction: (BoardingAction) -> Unit, modifier: Modifier) {
    val c = MaterialTheme.colorScheme
    val ctx = LocalContext.current
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    var sharing by remember { mutableStateOf(false) }
    var toast by remember { mutableStateOf("") }
    LaunchedEffect(state.invite?.id) {
        while (true) {
            now = System.currentTimeMillis()
            val invite = state.invite
            if (invite != null && invite.secondsLeft(now) == 0L) { onAction(BoardingAction.ExpireInvite); break }
            delay(500)
        }
    }
    LaunchedEffect(toast) { if (toast.isNotEmpty()) { delay(2500); toast = "" } }
    val invite = state.invite?.takeIf { it.secondsLeft(now) > 0 }
    val joined = session.trip?.people.orEmpty().filter { it.id !in state.joinedBefore }
    val title = session.trip?.title?.ifBlank { "함께하는 여행" } ?: "함께하는 여행"
    fun copy(text: String) {
        (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("가치타 참석 링크", text))
        toast = "복사했어요"
    }
    Box(modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(Shell.PARKED.gap)) {
            TitleBlock("동승자 초대하기", "초대 코드와 링크를 만들었어요. 편한 방식으로 전달해 주세요.")
            Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(36.dp)) {
                Surface(Modifier.width(650.dp).fillMaxHeight(), CarShape.Card, color = c.surface) {
                    Column(Modifier.padding(horizontal = 32.dp, vertical = 24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(43.dp)) {
                        Text("참석 QR", style = CarText.Body)
                        Text(invite?.secondsLeft(now)?.let { "남은 시간 ${it / 60}:${(it % 60).toString().padStart(2, '0')}" } ?: "QR은 5분 동안 쓸 수 있어요",
                            Modifier.height(56.dp).wrapContentHeight(), style = Title2) // 2047:2372 자리
                        if (invite != null) InviteQr(invite.url)
                        else Box(Modifier.size(320.dp), contentAlignment = Alignment.Center) {
                            Text(if (state.issuing) "참석 QR을 만들고 있어요" else state.note.ifBlank { "새 QR을 만들어 주세요" }, style = CarText.Body,
                                color = if (state.issuing) c.onSurfaceVariant else c.error, textAlign = TextAlign.Center)
                        }
                        Text("QR로도 바로 참여할 수 있어요", style = CarText.Body)
                    }
                }
                Column(Modifier.weight(1f).fillMaxHeight().padding(top = 24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                    Text("초대 링크", style = Title2)
                    Spacer(Modifier.height(15.dp)) // 2263:5777
                    Surface(Modifier.fillMaxWidth().height(181.dp), RoundedCornerShape(16.dp), color = c.primaryContainer, contentColor = c.onSurface) { // 2047:2378
                        Column(Modifier.padding(horizontal = 24.dp, vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically)) {
                            Text("$title 초대 링크", style = Title2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("열면 휴대폰에서 이 여행 참여와 녹음 동의로 연결", style = CarText.Body)
                        }
                    }
                    Spacer(Modifier.height(18.dp)) // 2189:6267
                    if (invite != null) {
                        CarButton("초대 링크 공유", height = 80.dp) { sharing = true }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                            CarButton("링크 복사", Modifier.weight(1f), CarButtonKind.Secondary, height = 80.dp) { copy(invite.url) }
                            CarButton("링크 열기", Modifier.weight(1f), CarButtonKind.Secondary, height = 80.dp) {
                                runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(invite.url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                            }
                        }
                    } else CarButton(if (state.issuing) "QR 준비 중" else "새 QR 만들기", kind = CarButtonKind.Secondary, height = 80.dp,
                        enabled = !state.issuing && session.online) { onAction(BoardingAction.Invite) }
                    Text(when {
                        joined.isNotEmpty() -> joined.joinToString(" · ") { "${it.name} ${Seat.entries.firstOrNull { seat -> seat.name == it.seat }?.label.orEmpty()}" } + " 참여 완료"
                        !session.online -> "연결을 확인하고 있어요. 참여 결과는 연결 후 갱신돼요."
                        else -> "QR 스캔, 초대 링크 모두 같은 여행으로 참여해요."
                    }, Modifier.fillMaxWidth(), style = CarText.Body.copy(fontFamily = FontFamily.Default), textAlign = TextAlign.Center, // 2263:5770 Noto Sans KR = 시스템 한글 글꼴
                        color = if (!session.online && joined.isEmpty()) c.error else c.onSurface)
                }
            }
        }
        CarToast(toast)
    }
    if (sharing && invite != null) ShareSheet(title, "참석 QR", invite.url, ctx, { copy(invite.url) }) { sharing = false }
}
