package io.github.teampitcrew.gachita

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

internal enum class BoardingPage { HIDDEN, PEOPLE, SCAN, SEAT, NAME, CONSENT, RESULT }
internal data class BoardingState(
    val page: BoardingPage = BoardingPage.HIDDEN,
    val name: String = "",
    val personId: String? = null,
    val seat: Seat? = null,
    val note: String = "",
    val qrReady: Boolean = false,
)
internal sealed interface BoardingAction {
    data object Close : BoardingAction
    data object Back : BoardingAction
    data object Scan : BoardingAction
    data object AddName : BoardingAction
    data class Name(val value: String) : BoardingAction
    data class PickSeat(val seat: Seat) : BoardingAction
    data class Move(val person: Person) : BoardingAction
    data class Consent(val person: Person) : BoardingAction
    data object Connect : BoardingAction
    data object Agree : BoardingAction
    data object Withdraw : BoardingAction
}

/** API 거절을 성공으로 표시하지 않는다. 자리 충돌은 QR을 유지하므로 빈자리를 다시 고를 수 있다. */
internal fun boardingFailure(error: Throwable): String = when {
    error is ApiError && error.status == 404 -> "QR 시간이 끝났거나 더 이상 쓸 수 없어요. 휴대폰에서 새 참석 QR을 만들어 주세요."
    error is ApiError && error.message.orEmpty().contains("이미 사용") -> "이미 연결한 QR이에요. 동승자 설정에서 현재 탑승자를 확인해 주세요."
    error is ApiError && error.status == 409 -> "그 자리에 다른 사람이 탔거나 이미 연결된 사람이에요. 현재 탑승자를 확인하고 빈자리를 다시 골라 주세요."
    else -> "연결 완료를 확인하지 못했어요. 동승자 설정에서 탑승자를 확인한 뒤 다시 시도해 주세요."
}

internal fun selectableSeat(trip: Trip, seats: List<String>, seat: Seat?, moving: String? = null): Boolean =
    seat != null && seat in seatRows(seats).flatten() && trip.people.none { it.seat == seat.name && it.id != moving }

@Composable
internal fun BoardingPanel(
    state: BoardingState, session: Session, seats: List<String>, scanning: Boolean,
    modifier: Modifier = Modifier, onAction: (BoardingAction) -> Unit, scanner: @Composable (Modifier) -> Unit,
) {
    val trip = session.trip ?: return
    val c = MaterialTheme.colorScheme
    Surface(modifier, shape = RoundedCornerShape(12.dp), color = c.surface) {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(when (state.page) {
                    BoardingPage.SCAN -> "참석 QR 읽기"
                    BoardingPage.SEAT -> "자리 선택"
                    BoardingPage.NAME -> "이름으로 추가"
                    BoardingPage.CONSENT -> "본인 녹음 동의"
                    BoardingPage.RESULT -> "함께 타고 있어요"
                    else -> "동승자 설정"
                }, Modifier.weight(1f), fontSize = 30.sp, fontWeight = FontWeight.Bold)
                OutlinedButton({ onAction(BoardingAction.Close) }, shape = RoundedCornerShape(10.dp), modifier = Modifier.heightIn(min = 56.dp)) { Text("닫기") }
            }
            when (state.page) {
                BoardingPage.PEOPLE -> PassengerList(trip, session, seats, onAction, Modifier.weight(1f))
                BoardingPage.SCAN -> {
                    Text(if (scanning) "휴대폰의 참석 QR을 보여 주세요" else "QR을 읽으려면 카메라가 필요해요", fontSize = 30.sp, fontWeight = FontWeight.Bold)
                    Text("읽으면 카메라가 멈추고 자리 선택으로 이어져요.", color = c.onSurfaceVariant)
                    if (scanning) scanner(Modifier.weight(1f).fillMaxWidth().clip(RoundedCornerShape(10.dp)))
                    else {
                        Text(state.note.ifBlank { "카메라는 QR을 읽는 동안만 사용해요. 허용하지 않아도 이름으로 추가할 수 있어요." }, color = c.onSurfaceVariant)
                        Spacer(Modifier.weight(1f))
                        BoardingButton("카메라 허용하고 읽기", !session.busy) { onAction(BoardingAction.Scan) }
                        BoardingButton("이름으로 추가", !session.busy, secondary = true) { onAction(BoardingAction.AddName) }
                    }
                    BoardingButton("동승자 설정으로", secondary = true) { onAction(BoardingAction.Back) }
                }
                BoardingPage.SEAT, BoardingPage.NAME -> BoardingSeatForm(state, session, seats, onAction, Modifier.weight(1f))
                BoardingPage.CONSENT -> PassengerConsent(state, session, onAction, Modifier.weight(1f))
                BoardingPage.RESULT -> BoardingResult(state, session, onAction, Modifier.weight(1f))
                else -> Unit
            }
        }
    }
}

@Composable
private fun PassengerList(trip: Trip, session: Session, seats: List<String>, action: (BoardingAction) -> Unit, modifier: Modifier) {
    val c = MaterialTheme.colorScheme
    Column(modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("누가 함께 타나요?", fontSize = 36.sp, fontWeight = FontWeight.Bold)
        Text("이 여행의 자리와 개인별 녹음 동의를 확인해요.", color = c.onSurfaceVariant)
        trip.people.forEach { person ->
            Surface(color = if (person.consent) c.primaryContainer else c.surfaceVariant, shape = RoundedCornerShape(10.dp)) {
                Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        Character(Seat.entries.indexOfFirst { it.name == person.seat }, 56.dp)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(person.name, fontWeight = FontWeight.Bold, fontSize = 27.sp)
                            Text("${Seat.entries.firstOrNull { it.name == person.seat }?.label ?: person.seat} · ${if (person.consent) "녹음 동의 완료" else "동의 대기"}", color = c.onSurfaceVariant, fontSize = 22.sp)
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        OutlinedButton({ action(BoardingAction.Move(person)) }, enabled = !session.busy && session.online && session.gear == "P",
                            shape = RoundedCornerShape(10.dp), modifier = Modifier.heightIn(min = 56.dp)) { Text("자리 변경", fontSize = 22.sp) }
                        OutlinedButton({ action(BoardingAction.Consent(person)) }, shape = RoundedCornerShape(10.dp), modifier = Modifier.heightIn(min = 56.dp)) {
                            Text(if (person.id in session.ours) "본인 동의 설정" else "휴대폰 동의 안내", fontSize = 22.sp)
                        }
                    }
                }
            }
        }
        HorizontalDivider()
        Text("새로 탄 사람", fontSize = 28.sp, fontWeight = FontWeight.Bold)
        Text("휴대폰에서 가치타의 참석 QR을 열어 주세요. 차에서 읽은 뒤 빈자리를 지정해요.", color = c.onSurfaceVariant)
        val canAdd = !session.busy && session.online && session.gear == "P" && freeSeats(trip, seats).isNotEmpty()
        BoardingButton("참석 QR 읽기", canAdd) { action(BoardingAction.Scan) }
        BoardingButton("휴대폰 없이 이름으로 추가", canAdd, secondary = true) { action(BoardingAction.AddName) }
        if (freeSeats(trip, seats).isEmpty()) Text("지금은 빈자리가 없어요.", color = c.onSurfaceVariant)
        if (!session.online) Text("연결이 끊겼어요. 연결되면 다시 추가할 수 있어요.", color = c.error)
        Text(session.note.ifBlank { "주차 중에만 자리를 바꾸거나 새로 연결할 수 있어요." }, color = c.onSurfaceVariant, fontSize = 22.sp)
    }
}

@Composable
private fun BoardingSeatForm(state: BoardingState, session: Session, seats: List<String>, action: (BoardingAction) -> Unit, modifier: Modifier) {
    val trip = session.trip ?: return
    val person = trip.people.firstOrNull { it.id == state.personId }
    val c = MaterialTheme.colorScheme
    Column(modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        if (state.page == BoardingPage.NAME) OutlinedTextField(state.name, { action(BoardingAction.Name(it.take(24))) },
            label = { Text("이름") }, singleLine = true, enabled = !session.busy, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp))
        else Text(person?.let { "${it.name}님의 자리를 바꿔요" } ?: "참석 QR을 읽었어요", fontSize = 32.sp, fontWeight = FontWeight.Bold)
        Text("어느 자리에 앉았나요?", fontSize = 28.sp, fontWeight = FontWeight.Bold)
        Text("차 앞쪽", color = c.onSurfaceVariant, fontSize = 22.sp)
        seatRows(seats).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                row.forEach { seat ->
                    val occupant = trip.people.firstOrNull { it.seat == seat.name }
                    val selected = state.seat == seat
                    Surface(onClick = { action(BoardingAction.PickSeat(seat)) },
                        enabled = !session.busy && selectableSeat(trip, seats, seat, state.personId),
                        shape = RoundedCornerShape(10.dp), color = if (selected) c.primaryContainer else c.surface,
                        border = BorderStroke(if (selected) 2.dp else 1.dp, if (selected) c.primary else c.outlineVariant),
                        modifier = Modifier.weight(1f).heightIn(min = 92.dp)) {
                        Column(Modifier.padding(12.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(seat.label.removePrefix("뒷자리 "), fontSize = 22.sp)
                            Text(if (selected) "선택" else occupant?.name ?: "빈자리", fontWeight = FontWeight.Bold, fontSize = 22.sp)
                        }
                    }
                }
            }
        }
        Text(state.seat?.let { "선택한 자리 · ${it.label}" } ?: "빈자리를 골라 주세요", fontWeight = FontWeight.Bold)
        if (person == null) Text(if (state.page == BoardingPage.NAME) "녹음 동의는 꺼진 상태로 추가해요. 연결 뒤 본인이 동의를 확인해 주세요."
            else "연결 후 본인의 휴대폰에서 녹음에 동의해 주세요. 다른 사람의 동의를 대신 켤 수 없어요.", color = c.onSurfaceVariant)
        if (state.note.isNotBlank()) Text(state.note, color = c.error)
        BoardingButton(if (session.busy) "연결하고 있어요" else if (person != null) "이 자리로 변경" else "이 자리에 연결",
            !session.busy && session.online && session.gear == "P" && selectableSeat(trip, seats, state.seat, state.personId) && (state.page != BoardingPage.NAME || state.name.isNotBlank()) && (state.page != BoardingPage.SEAT || person != null || state.qrReady)) { action(BoardingAction.Connect) }
        BoardingButton(if (person == null && state.page == BoardingPage.SEAT) "다른 QR 읽기" else "동승자 설정으로", !session.busy, secondary = true) {
            action(if (person == null && state.page == BoardingPage.SEAT) BoardingAction.Scan else BoardingAction.Back)
        }
        if (person == null && state.page == BoardingPage.SEAT) BoardingButton("동승자 설정으로", secondary = true) { action(BoardingAction.Back) }
    }
}

@Composable
private fun PassengerConsent(state: BoardingState, session: Session, action: (BoardingAction) -> Unit, modifier: Modifier) {
    val person = session.trip?.people?.firstOrNull { it.id == state.personId } ?: return
    val c = MaterialTheme.colorScheme
    Column(modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Character(Seat.entries.indexOfFirst { it.name == person.seat }, 80.dp)
        Text("${person.name}님의 녹음 동의", fontSize = 34.sp, fontWeight = FontWeight.Bold)
        Text("${person.name}님 본인이 확인해 주세요. 다른 사람 대신 동의를 켤 수 없어요.", color = c.onSurfaceVariant)
        Text("함께 나눈 목소리를 받아 적고, 고른 장면을 쇼츠로 남겨요. 모두 동의한 상태에서 녹음 시작을 눌러야 마이크가 켜져요.")
        Text("기간 제한 없이 보관해요. 동의를 철회하면 녹음을 즉시 멈추고 여행의 원음과 대화를 지워요. 이미 기기에 저장한 영상은 따로 삭제해 주세요.", color = c.onSurfaceVariant)
        if (person.id in session.ours) {
            BoardingButton(if (person.consent) "내 녹음 동의 철회" else "본인 동의 켜기", if (person.consent) !session.offPending else session.blockOn() == null) {
                action(if (person.consent) BoardingAction.Withdraw else BoardingAction.Agree)
            }
        } else Text("참석 QR로 연결한 사람은 자신의 휴대폰에서 동의를 바꿀 수 있어요.", color = c.primary, fontWeight = FontWeight.Bold)
        Text(session.note.ifBlank { if (person.consent) "현재 동의 켜짐" else "현재 동의 꺼짐" }, color = c.onSurfaceVariant)
        BoardingButton("동승자 설정으로", secondary = true) { action(BoardingAction.Back) }
    }
}

@Composable
private fun BoardingResult(state: BoardingState, session: Session, action: (BoardingAction) -> Unit, modifier: Modifier) {
    val person = session.trip?.people?.firstOrNull { it.id == state.personId }
    val c = MaterialTheme.colorScheme
    Column(modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(24.dp)) {
        Character(state.seat?.ordinal ?: 0, 96.dp)
        Text("${person?.name ?: state.name}님이 함께 타고 있어요", fontSize = 34.sp, fontWeight = FontWeight.Bold)
        Text(state.seat?.label.orEmpty(), fontSize = 28.sp)
        Text(if (person?.consent == true) "녹음 동의가 완료됐어요. 모두 동의하면 홈에서 녹음을 시작할 수 있어요."
            else "녹음 동의를 기다리고 있어요. ${if (person?.id in session.ours) "본인이 동의 설정을 확인해 주세요." else "본인의 휴대폰에서 동의를 선택해 주세요."}", color = c.onSurfaceVariant)
        if (state.note.isNotBlank()) Text(state.note, color = c.onSurfaceVariant)
        if (person != null && person.id in session.ours) BoardingButton("본인 동의 설정") { action(BoardingAction.Consent(person)) }
        BoardingButton("동승자 설정으로", secondary = true) { action(BoardingAction.Back) }
    }
}

@Composable
private fun BoardingButton(label: String, enabled: Boolean = true, secondary: Boolean = false, click: () -> Unit) {
    if (secondary) OutlinedButton(click, Modifier.fillMaxWidth().heightIn(min = 64.dp), enabled = enabled, shape = RoundedCornerShape(10.dp)) { Text(label) }
    else Button(click, Modifier.fillMaxWidth().heightIn(min = 64.dp), enabled = enabled, shape = RoundedCornerShape(10.dp)) { Text(label) }
}
