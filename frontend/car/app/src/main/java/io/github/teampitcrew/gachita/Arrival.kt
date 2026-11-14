package io.github.teampitcrew.gachita

import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/*
 * Arrival brief of the final design (C20 '{place}에 도착했어요', Figma 2005:3369). It replaces the T123 card look but keeps
 * the T113 flow: only server todos, server-approved arrival items, status changes after the server answers, sources on demand.
 * grouping is covered by ArrivalGroupTest.
 */

/** Asks said by one person. person is null when no source has a confirmed speaker (shown last as '말한 사람 미확인'). */
internal data class AskGroup(val person: Person?, val items: List<SharedTodo>)

/** Groups asks by their first confirmed speaker, in server order with open items first. Unknown speakers go last. */
internal fun asksByPerson(items: List<SharedTodo>, people: List<Person>): List<AskGroup> {
    val groups = LinkedHashMap<String?, MutableList<SharedTodo>>()
    items.sortedBy { if (it.pending) 0 else 1 }.forEach { groups.getOrPut(askSpeaker(it, people)?.id) { mutableListOf() } += it }
    return groups.entries.sortedBy { if (it.key == null) 1 else 0 }.map { (id, list) -> AskGroup(people.find { it.id == id }, list) }
}

/** The design's tint-3 (#3a2530) marks the first person's card. It has no light value in Figma, so light mode uses a pale version. */
@Composable
private fun firstTint() = if (isSystemInDarkTheme()) Color(0xFF3A2530) else Color(0xFFF7E9EF)

/**
 * C20 arrival screen (place != null) or the per-place list from trip tools and Gleo (place == null).
 * [canChange] gates done/reopen/cancel (real P, online, same scope); [canArrive] gates the manual arrival check.
 */
@Composable
internal fun ArrivalBrief(
    place: String?, items: List<SharedTodo>, people: List<Person>, todo: SharedTodoState, arrivalNote: String,
    canChange: Boolean, canArrive: Boolean, arriving: Boolean,
    onStatus: (SharedTodo, String) -> Unit, onRefresh: () -> Unit, onArrive: () -> Unit, onClose: () -> Unit, modifier: Modifier = Modifier,
) {
    val c = MaterialTheme.colorScheme
    Column(modifier, verticalArrangement = Arrangement.spacedBy(24.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(if (place != null) "${place}에 도착했어요" else "장소별 할 일", fontSize = 40.sp, lineHeight = 50.sp, fontWeight = FontWeight.Bold)
            Text(if (place != null) "내리기 전, 가족이 말한 부탁을 한눈에" else "오는 길에 나온 부탁을 말한 사람별로 모았어요", color = c.onSurfaceVariant, fontSize = 24.sp, lineHeight = 32.sp)
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            val groups = asksByPerson(items, people)
            groups.forEachIndexed { i, g -> PersonAsks(g, place == null, i == 0 && g.items.any { it.pending }, people, canChange, onStatus) }
            if (items.isEmpty() && todo.data != null && !todo.loading) Text("이 목록에 할 일이 없어요", color = c.onSurfaceVariant, fontSize = 28.sp)
            Text(if (place != null) "방금까지의 대화에서 이 장소에 필요한 내용만 모았어요." else "오는 길의 대화에서 장소가 붙은 부탁만 모았어요.", color = c.onSurfaceVariant, fontSize = 24.sp, lineHeight = 32.sp)
            val synced = todo.syncedAt?.let { SimpleDateFormat("HH:mm:ss", Locale.KOREA).format(Date(it)) }
            Text(when {
                todo.scope == null -> "탑승자 모두의 기록 동의와 참가자 연결이 필요해요"
                todo.loading -> "서버 목록을 갱신하고 있어요"
                synced != null -> "마지막 동기화 $synced · 서버 기록"
                else -> "아직 서버 목록을 확인하지 못했어요"
            }, color = c.onSurfaceVariant, fontSize = 20.sp)
            if (todo.note.isNotEmpty()) Text(todo.note, color = c.error, fontSize = 20.sp)
            if (arrivalNote.isNotEmpty()) Text(arrivalNote, color = c.onSurfaceVariant, fontSize = 20.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(onRefresh, Modifier.weight(1f).heightIn(min = 64.dp), enabled = !todo.loading, shape = RoundedCornerShape(24.dp)) { Text("새로고침") }
                OutlinedButton(onArrive, Modifier.weight(1f).heightIn(min = 64.dp), enabled = canArrive && !arriving, shape = RoundedCornerShape(24.dp)) { Text("도착 확인") }
            }
        }
        BigButton(DriveButton(if (place != null) "여행 계속" else "닫기", Press.GO, true), onClose, Modifier.fillMaxWidth().height(96.dp))
    }
}

/** One person's card: character, '{name}  {ask}' and the original words, with done/reopen, sources and cancel per ask. */
@Composable
private fun PersonAsks(g: AskGroup, showPlace: Boolean, first: Boolean, people: List<Person>, canChange: Boolean, onStatus: (SharedTodo, String) -> Unit) {
    val c = MaterialTheme.colorScheme
    Surface(Modifier.fillMaxWidth(), RoundedCornerShape(32.dp), color = if (first) firstTint() else c.surface) {
        Row(Modifier.padding(26.dp), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            if (g.person != null) Character(seatCharacter(g.person), 92.dp) else Box(Modifier.size(92.dp).clip(CircleShape).background(c.surfaceVariant))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                g.items.forEachIndexed { i, item -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    var open by remember(item.id) { mutableStateOf(false) }
                    val name = g.person?.name ?: "말한 사람 미확인"
                    Text(if (i == 0) "$name  ${shortAsk(item)}" else shortAsk(item), fontSize = 32.sp, lineHeight = 42.sp, fontWeight = FontWeight.Bold,
                        color = if (item.pending) c.onSurface else c.onSurfaceVariant)
                    val said = item.sources.minByOrNull { it.at }
                    Text(listOfNotNull(
                        item.place.takeIf { showPlace },
                        said?.let { "“${it.displayText}”" },
                        said?.let { SimpleDateFormat("HH:mm", Locale.KOREA).format(Date(it.at)) },
                        when (item.status) { "done" -> "완료"; "cancelled" -> "취소"; else -> null },
                    ).joinToString(" · "), color = c.onSurfaceVariant, fontSize = 24.sp, lineHeight = 32.sp)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton({ onStatus(item, if (item.pending) "done" else "pending") }, Modifier.heightIn(min = 56.dp), enabled = canChange,
                            shape = RoundedCornerShape(24.dp)) { Text(if (item.pending) "완료" else "다시 열기") }
                        TextButton({ open = !open }, Modifier.heightIn(min = 56.dp)) { Text(if (open) "원문 접기" else "원문 ${item.sources.size}개 보기") }
                        if (item.pending) TextButton({ onStatus(item, "cancelled") }, Modifier.heightIn(min = 56.dp), enabled = canChange) { Text("취소") }
                    }
                    if (open) item.sources.forEach { s ->
                        val at = SimpleDateFormat("HH:mm:ss", Locale.KOREA).format(Date(s.at))
                        Text("$at · ${people.find { it.id == s.participantId }?.name ?: "화자 미확인"}", color = c.onSurfaceVariant, fontSize = 18.sp)
                        Text(s.text, fontSize = 20.sp)
                        if (s.displayText != s.text) Text("보정 · ${s.displayText}", color = c.onSurfaceVariant, fontSize = 20.sp)
                    }
                } }
            }
        }
    }
}
