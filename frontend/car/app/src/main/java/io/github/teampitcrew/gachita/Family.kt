package io.github.teampitcrew.gachita

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import kotlin.math.floor

/*
 * 가족·동승 그룹(흐름 F2, T133): C09–C16, C39–C43(시연판 D08–D16·D補 seat·swapped·guest·guestInvite), 초대 링크 공유·복사.
 * 서버 계약은 docs/api/groups.md. 주차 중에만 연다(Setup에서). 화면: 왼쪽 본문, 오른쪽 '차가 바뀌어도 우리는 그대로' 칸, 아래 단추.
 */

data class GroupMember(val profileId: String, val name: String, val character: String, val hasVoice: Boolean, val consent: Boolean, val role: String, val seat: String?)
data class GroupInvite(val code: String, val url: String)
data class CarGroup(val id: String, val name: String, val kind: String, val members: List<GroupMember>, val invite: GroupInvite?)

fun parseGroup(o: JSONObject): CarGroup {
    val ms = o.getJSONArray("members")
    return CarGroup(
        o.getString("id"), o.getString("name"), o.getString("kind"),
        (0 until ms.length()).map { ms.getJSONObject(it) }.map {
            GroupMember(it.getString("profileId"), it.getString("name"), it.optString("character"), it.optBoolean("hasVoice"), it.optBoolean("consent"),
                it.getString("role"), it.optString("seat").takeIf { s -> s.isNotEmpty() && s != "null" })
        },
        o.optJSONObject("invite")?.let { GroupInvite(it.getString("code"), it.getString("url")) },
    )
}

/** 두 사람의 자리를 맞바꾼다(C14). 바꾸지 않은 사람은 그대로. */
fun swapSeats(members: List<GroupMember>, a: String, b: String): List<GroupMember> {
    val sa = members.firstOrNull { it.profileId == a }?.seat
    val sb = members.firstOrNull { it.profileId == b }?.seat
    return members.map { if (it.profileId == a) it.copy(seat = sb) else if (it.profileId == b) it.copy(seat = sa) else it }
}

/** 우리 가족(C13) 아래 줄. */
fun readiness(members: List<GroupMember>): String {
    val consent = members.count { it.consent }
    val voice = members.count { it.hasVoice }
    return if (consent == members.size && voice == members.size) "동의와 목소리 등록 완료 / 다음 탑승부터 자동 기록 켜짐"
    else "녹음 동의 $consent/${members.size}명 / 목소리 등록 $voice/${members.size}명"
}

// mock: 차 로그인(흐름 F1, POST /api/sessions)이 들어오기 전에는 프로필 토큰이 없어 시안의 시연 가족을 보여 준다.
// 디버그 실행 인자(--es profileToken)로 토큰을 주면 서버의 실제 그룹을 읽고 고친다.
val DEMO_FAMILY = CarGroup("demo", "우리 가족", "family", listOf(
    GroupMember("demo-dad", "아빠", "glasses", true, true, "owner", "ROW_1_LEFT"),
    GroupMember("demo-mom", "엄마", "healing", true, true, "adult", "ROW_1_RIGHT"),
    GroupMember("demo-son", "서준", "cap", true, true, "child", "ROW_2_LEFT"),
    GroupMember("demo-girl", "하은", "basic-small", true, true, "child", "ROW_2_RIGHT"),
), GroupInvite("FAMILY-2714", "/?group=FAMILY-2714"))

private enum class FamilyView { MEMBER, INVITE, CHILD, CHILD_VOICE, GROUP, SEAT, GUEST }

private fun charRes(key: String): Int {
    val small = key.endsWith("-small")
    return when (key.removeSuffix("-small")) {
        "cap" -> if (small) R.drawable.char_cap_small else R.drawable.char_cap
        "glasses" -> if (small) R.drawable.char_glasses_small else R.drawable.char_glasses
        "travel" -> if (small) R.drawable.char_travel_small else R.drawable.char_travel
        "game" -> if (small) R.drawable.char_game_small else R.drawable.char_game
        "healing" -> if (small) R.drawable.char_healing_small else R.drawable.char_healing
        "camping" -> if (small) R.drawable.char_camping_small else R.drawable.char_camping
        "office" -> if (small) R.drawable.char_office_small else R.drawable.char_office
        "pet" -> if (small) R.drawable.char_pet_small else R.drawable.char_pet
        "sport" -> if (small) R.drawable.char_sport_small else R.drawable.char_sport
        else -> if (small) R.drawable.char_basic_small else R.drawable.char_basic
    }
}

@Composable
private fun Face(key: String, size: Int) = Image(painterResource(charRes(key)), null, Modifier.size(size.dp), contentScale = ContentScale.Fit)

/**
 * 가족 흐름 전체. server는 API 주소, token은 이 차에 로그인한 프로필 토큰(없으면 시연 가족, mock).
 * onStart(groupId)는 '이 가족과 출발' — 부르는 쪽(MainActivity)이 POST /api/trips {groupId}로 여행을 만든다.
 */
@Composable
fun FamilyFlow(server: String, token: String?, onClose: () -> Unit, onStart: (String) -> Unit) {
    val c = MaterialTheme.colorScheme
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var groups by remember { mutableStateOf(if (token == null) listOf(DEMO_FAMILY) else emptyList()) }
    var groupId by remember { mutableStateOf<String?>(null) }
    var view by remember { mutableStateOf(FamilyView.MEMBER) }
    var invite by remember { mutableStateOf<GroupInvite?>(null) }
    var busy by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf("") }
    var childName by remember { mutableStateOf("") }
    var childChar by remember { mutableStateOf("cap") }
    var childConsent by remember { mutableStateOf(true) }
    var child by remember { mutableStateOf<GroupMember?>(null) }
    var voiceSec by remember { mutableStateOf(0) }
    var seats by remember { mutableStateOf<List<GroupMember>>(emptyList()) }
    var picked by remember { mutableStateOf<String?>(null) }
    var swapped by remember { mutableStateOf<Pair<String, String>?>(null) }
    var saved by remember { mutableStateOf(false) }
    var guestName by remember { mutableStateOf("") }
    var myName by remember { mutableStateOf("민준") } // mock: 토큰이 없을 때의 시연 이름

    val api = remember(server) { Server(server) }
    fun family() = groups.firstOrNull { it.kind == "family" }
    fun current() = groups.firstOrNull { it.id == groupId } ?: family()
    fun put(g: CarGroup) { groups = groups.filter { it.id != g.id } + g }
    fun act(work: suspend () -> Unit) {
        if (busy) return
        busy = true; note = ""
        scope.launch {
            runCatching { work() }.onFailure { note = failureText(it) }
            busy = false
        }
    }
    suspend fun <T> io(block: () -> T): T = withContext(Dispatchers.IO) { block() }
    suspend fun load() { if (token != null) { groups = io { api.groups(token) }; myName = io { api.profileName(token) } } }
    suspend fun ensureFamily(): CarGroup = family() ?: io { api.createGroup(token!!, "우리 가족", "family") }.also { put(it) }
    suspend fun issue(g: CarGroup) {
        groupId = g.id
        invite = if (token == null) g.invite else io { api.groupInvite(token, g.id) }
        view = FamilyView.INVITE
    }
    fun toast(text: String) { note = text; scope.launch { delay(2500); if (note == text) note = "" } }
    fun link() = server.trimEnd('/') + (invite?.url ?: "")
    fun copy(text: String) {
        (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("가치타 초대", text))
        toast("복사했어요") // 2047:2276
    }

    LaunchedEffect(token) {
        if (token == null) { view = FamilyView.GROUP; return@LaunchedEffect }
        busy = true
        runCatching { load() }.onFailure { note = failureText(it) }
        val members = family()?.members.orEmpty()
        view = if (members.size > 1 && members.all { it.seat != null }) FamilyView.GROUP else FamilyView.MEMBER
        busy = false
    }
    BackHandler {
        view = when (view) {
            FamilyView.INVITE -> if (current()?.kind == "guest") FamilyView.GROUP else FamilyView.MEMBER
            FamilyView.CHILD, FamilyView.CHILD_VOICE -> FamilyView.MEMBER
            FamilyView.SEAT, FamilyView.GUEST -> FamilyView.GROUP
            else -> { onClose(); view }
        }
    }
    // mock: 아이 목소리 15초(C12·C42)는 진행만 그린다. 값 올리기(Voice.kt embed → POST /groups/{id}/members/{profileId}/voice)는 다음 커밋.
    LaunchedEffect(view, child) {
        if (view != FamilyView.CHILD_VOICE) return@LaunchedEffect
        voiceSec = 0
        while (voiceSec < 15) { delay(1000); voiceSec++ }
    }

    val g = current()
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            AppBar("", listening = false, "주차 중  P" to true)
            if (view == FamilyView.GROUP || view == FamilyView.SEAT || view == FamilyView.GUEST) Tabs(onClose)
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                Column(Modifier.weight(1.6f), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    when (view) {
                        FamilyView.MEMBER -> {
                            val others = family()?.members.orEmpty().filter { it.name != myName && it.role != "owner" }
                            val kids = others.filter { it.role == "child" }
                            val adults = others.filter { it.role != "child" }
                            Heading(when { kids.isNotEmpty() -> "${kids.last().name}까지 준비됐어요"; adults.isNotEmpty() -> "${adults.last().name}${if (batchim(adults.last().name)) "이" else "가"} 함께해요"; else -> "우리 가족 추가" },
                                when { kids.isNotEmpty() -> "${(listOf(myName) + adults.map { it.name } + kids.map { it.name }).joinToString(", ")} 준비 완료 / 다음 아이를 추가해 주세요."; adults.isNotEmpty() -> "${adults.last().name} 계정 연결 완료 / 이제 아이를 추가해 주세요."; else -> "기존 계정 연결 또는 아이 프로필 직접 만들기" })
                            Row2(soft = true) { Face("glasses", 72); Column { Text(myName, fontSize = 30.sp, fontWeight = FontWeight.Bold); Text("내 계정 / 목소리 등록 완료", color = c.onSurfaceVariant) } }
                            (adults + kids).forEach { m -> Row2 { Face(m.character, 64); Column { Text(m.name, fontSize = 28.sp, fontWeight = FontWeight.Bold); Text(if (m.role == "child") "아이 프로필 / ${if (m.hasVoice) "목소리 등록 완료" else "목소리 등록 전"}" else "계정 연결 완료", color = c.onSurfaceVariant) } } }
                            Ghost("가족 계정 초대하기", !busy) { act { issue(ensureFamily()) } }
                            Ghost("아이 프로필 만들기", !busy) { view = FamilyView.CHILD }
                            Info("가족 그룹은 한 번만", "저장한 구성원과 좌석을 다음 여행에도 사용")
                        }
                        FamilyView.INVITE -> InviteBody(current(), invite, ::copy, ::link, ctx)
                        FamilyView.CHILD -> {
                            Heading("아이 프로필 만들기", "보호자가 이름과 캐릭터, 목소리를 관리해요.")
                            Text("아이 이름", color = c.onSurfaceVariant)
                            OutlinedTextField(childName, { childName = it.take(20) }, Modifier.fillMaxWidth(), singleLine = true, placeholder = { Text("서준") })
                            Row2(onClick = { childChar = CHARS[(CHARS.indexOf(childChar) + 1) % CHARS.size] }) { Face(childChar, 96); Text("${CHAR_LABEL[childChar.removeSuffix("-small")] ?: ""} ${childName}".trim(), fontSize = 28.sp, fontWeight = FontWeight.Bold) }
                            Info("아이 목소리 15초 등록", "아이에게 짧은 문장을 읽어 달라고 해주세요.")
                            Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(childConsent, { childConsent = it }); Text("보호자로서 아이의 녹음과 콘텐츠 처리에 동의해요.", color = c.onSurfaceVariant) }
                        }
                        FamilyView.CHILD_VOICE -> {
                            val name = child?.name ?: childName.ifBlank { "아이" }
                            Heading("${name}의 목소리 등록", "“나는 ${name}${if (batchim(name)) "이야" else "야"}. 바다에 가서 모래성을 만들 거야.”")
                            Card2 {
                                Text("아이 목소리  $voiceSec / 15초", color = c.onSurfaceVariant)
                                Row(Modifier.fillMaxWidth().height(96.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                                    repeat(40) { i -> Box(Modifier.weight(1f).height(if (i < voiceSec * 40 / 15) (24 + (i * 37) % 60).dp else 12.dp).background(c.primary, RoundedCornerShape(3.dp))) }
                                }
                                Text("00:${voiceSec.toString().padStart(2, '0')}", color = c.onSurfaceVariant)
                            }
                            if (voiceSec >= 15) Row2(soft = true) { Face(child?.character ?: childChar, 72); Column { Text("${name}의 프로필 준비 완료", fontSize = 28.sp, fontWeight = FontWeight.Bold); Text("다음 아이도 같은 방법으로 추가할 수 있어요.", color = c.onSurfaceVariant) } }
                        }
                        FamilyView.GROUP, FamilyView.SEAT -> {
                            val list = if (view == FamilyView.SEAT) seats else g?.members.orEmpty()
                            Heading(if (view == FamilyView.SEAT) "가족 좌석 바꾸기" else if (g?.kind == "guest") g.name else "우리 가족",
                                if (view == FamilyView.SEAT) swapped?.let { sw -> val rear = seats.filter { it.name == sw.first || it.name == sw.second }.all { it.seat?.startsWith("ROW_2_") == true }
                                    "${sw.first}${if (batchim(sw.first)) "과" else "와"} ${sw.second}의 ${if (rear) "뒷자리" else "자리"} 위치를 바꿨어요." } ?: "바꿀 두 사람을 차례로 눌러 주세요."
                                else if (saved) "새 좌석을 저장했어요." else "${list.size}명 / ${if (g?.kind == "guest") "동승 그룹" else "기본 그룹"} / 좌석을 눌러 변경")
                            SeatGrid(list, picked) { m ->
                                if (view == FamilyView.GROUP) { seats = list; picked = m.profileId; swapped = null; saved = false; view = FamilyView.SEAT; return@SeatGrid }
                                val p = picked
                                if (p == null || p == m.profileId) picked = m.profileId
                                else { seats = swapSeats(seats, p, m.profileId); swapped = (seats.first { it.profileId == p }.name to m.name); picked = null }
                            }
                            if (view == FamilyView.GROUP) Text(readiness(list), color = c.primary)
                        }
                        FamilyView.GUEST -> {
                            Heading("새 동승 그룹", "가족 외 동승자도 여행별로 함께할 수 있어요.")
                            Text("그룹 이름", color = c.onSurfaceVariant)
                            OutlinedTextField(guestName, { guestName = it.take(20) }, Modifier.fillMaxWidth(), singleLine = true, placeholder = { Text("주말 바다 친구들") })
                            Row2(soft = true) { Face("glasses", 72); Column { Text("내 계정", fontSize = 28.sp, fontWeight = FontWeight.Bold); Text("$myName / 운전석", color = c.onSurfaceVariant) } }
                            Ghost("계정 초대 링크 만들기", !busy && token != null) { act { val made = io { api.createGroup(token!!, guestName.trim().ifBlank { "동승 그룹" }, "guest") }; put(made); issue(made) } }
                            Text("새 동승자는 본인이 동의한 뒤 그룹에 참여해요.", color = c.onSurfaceVariant)
                        }
                    }
                }
                SidePanel(family() ?: g, Modifier.weight(1f))
            }
            // 아래 단추
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                when (view) {
                    FamilyView.MEMBER -> Primary(if (family()?.members.orEmpty().any { it.role == "adult" }) "아이 프로필 만들기" else "가족 계정 초대하기", !busy, Modifier.weight(1f)) {
                        if (family()?.members.orEmpty().any { it.role == "adult" }) view = FamilyView.CHILD else act { issue(ensureFamily()) }
                    }
                    FamilyView.INVITE -> Primary(if (current()?.kind == "guest") "참여 확인하고 그룹으로" else "참여 확인", !busy, Modifier.weight(1f)) {
                        act { load(); view = if (current()?.kind == "guest") FamilyView.GROUP else FamilyView.MEMBER }
                    }
                    FamilyView.CHILD -> Primary("동의하고 목소리 등록", !busy && childName.isNotBlank() && token != null, Modifier.weight(1f)) {
                        act {
                            val fam = ensureFamily()
                            val made = io { api.addChild(token!!, fam.id, childName.trim(), childChar, childConsent) }
                            put(made); child = made.members.lastOrNull { it.role == "child" }; view = FamilyView.CHILD_VOICE
                        }
                    }
                    FamilyView.CHILD_VOICE -> Primary(if (voiceSec >= 15) "가족 그룹에 저장" else "녹음 중", voiceSec >= 15 && !busy, Modifier.weight(1f)) {
                        act { load(); childName = ""; view = FamilyView.MEMBER }
                    }
                    FamilyView.GROUP -> {
                        Ghost("새 동승 그룹", true, Modifier.weight(0.6f)) { guestName = ""; view = FamilyView.GUEST }
                        Primary(if (g?.kind == "guest") "이 그룹과 출발" else "이 가족과 출발", !busy && token != null && g != null, Modifier.weight(1.4f)) { g?.let { onStart(it.id) } }
                    }
                    FamilyView.SEAT -> Primary("이 배치로 저장", !busy && swapped != null && token != null, Modifier.weight(1f)) {
                        act {
                            val before = g!!.members.associate { it.profileId to it.seat }
                            val changes = seats.filter { before[it.profileId] != it.seat }.associate { it.profileId to it.seat }
                            put(io { api.saveSeats(token!!, g.id, changes) }); saved = true; view = FamilyView.GROUP
                        }
                    }
                    FamilyView.GUEST -> Primary("그룹 저장", !busy && token != null, Modifier.weight(1f)) {
                        act { val made = io { api.createGroup(token!!, guestName.trim().ifBlank { "동승 그룹" }, "guest") }; put(made); groupId = made.id; saved = false; view = FamilyView.GROUP }
                    }
                }
            }
        }
        if (note.isNotEmpty()) Surface(Modifier.align(Alignment.BottomCenter).padding(bottom = 160.dp), RoundedCornerShape(24.dp), color = c.onSurface) {
            Text(note, Modifier.padding(horizontal = 48.dp, vertical = 24.dp), color = c.surface, fontSize = 26.sp, fontWeight = FontWeight.Bold)
        }
    }
}

private val CHARS = listOf("cap", "basic-small", "glasses", "travel", "game", "healing", "camping", "sport", "pet", "office")
private val CHAR_LABEL = mapOf("basic" to "기본", "cap" to "캡모자", "glasses" to "안경", "travel" to "여행", "game" to "게임", "sport" to "운동", "pet" to "반려동물", "camping" to "캠핑", "office" to "직장인", "healing" to "힐링")
private fun batchim(word: String): Boolean = word.trim().lastOrNull()?.let { it in '가'..'힣' && (it - '가') % 28 != 0 } ?: false

@Composable
private fun Tabs(onClose: () -> Unit) {
    val c = MaterialTheme.colorScheme
    Surface(Modifier.fillMaxWidth(), RoundedCornerShape(16.dp), color = c.surface) {
        Row(Modifier.padding(6.dp)) {
            listOf("함께 타는 중", "대화 기록", "콘텐츠 기록").forEachIndexed { i, label ->
                Surface(Modifier.weight(1f).clickable(enabled = i > 0) { onClose() }, RoundedCornerShape(12.dp), color = if (i == 0) c.primaryContainer else Color.Transparent) {
                    Text(label, Modifier.padding(14.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center, color = if (i == 0) c.onSurface else c.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun Heading(title: String, sub: String) {
    Text(title, fontSize = 40.sp, fontWeight = FontWeight.Bold)
    Text(sub, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun Row2(soft: Boolean = false, onClick: (() -> Unit)? = null, content: @Composable () -> Unit) {
    val c = MaterialTheme.colorScheme
    Surface(Modifier.fillMaxWidth().then(if (onClick != null) Modifier.clickable { onClick() } else Modifier), RoundedCornerShape(32.dp), color = if (soft) c.primaryContainer else c.surface) {
        Row(Modifier.padding(horizontal = 24.dp, vertical = 18.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(20.dp)) { content() }
    }
}

@Composable
private fun Card2(content: @Composable ColumnScope.() -> Unit) = CarCard(content = content)

@Composable
private fun Info(title: String, detail: String) = CarCard {
    Text(title, fontSize = 30.sp, fontWeight = FontWeight.Bold)
    Text(detail, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun Ghost(label: String, enabled: Boolean, modifier: Modifier = Modifier.fillMaxWidth(), onClick: () -> Unit) {
    val c = MaterialTheme.colorScheme
    Button(onClick, modifier.height(72.dp), enabled = enabled, shape = RoundedCornerShape(24.dp), colors = ButtonDefaults.buttonColors(containerColor = c.surfaceVariant, contentColor = c.onSurface)) {
        Text(label, fontSize = 28.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun Primary(label: String, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) =
    Button(onClick, modifier.height(88.dp), enabled = enabled, shape = RoundedCornerShape(24.dp)) { Text(label, fontSize = 30.sp, fontWeight = FontWeight.Bold) }

@Composable
private fun SidePanel(g: CarGroup?, modifier: Modifier) = CarCard(modifier = modifier) {
    val c = MaterialTheme.colorScheme
    Text("차가 바뀌어도\n우리는 그대로", fontSize = 34.sp, fontWeight = FontWeight.Bold, lineHeight = 46.sp)
    Text("한 번 만든 가족 프로필로\n차량과 폰에서 이어가세요.", color = c.onSurfaceVariant, lineHeight = 36.sp)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { g?.members.orEmpty().take(5).forEach { Face(it.character, 72) } }
    Text("우리 가족  ${g?.members?.size ?: 1}명", fontSize = 28.sp, fontWeight = FontWeight.Bold)
    Text("프로필과 목소리, 가족 그룹을\n같은 계정으로 함께 사용", color = c.onSurfaceVariant, lineHeight = 34.sp)
}

@Composable
private fun SeatGrid(members: List<GroupMember>, picked: String?, onPick: (GroupMember) -> Unit) = CarCard {
    val c = MaterialTheme.colorScheme
    val at = members.filter { it.seat != null }.associateBy { it.seat }
    Text("차량 앞쪽 ↑", color = c.onSurfaceVariant)
    listOf(listOf(Seat.ROW_1_LEFT, Seat.ROW_1_RIGHT), listOf(Seat.ROW_2_LEFT, Seat.ROW_2_RIGHT)).forEach { row ->
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            row.forEach { seat ->
                val m = at[seat.name]
                Surface(Modifier.weight(1f).clickable(enabled = m != null) { m?.let(onPick) }, RoundedCornerShape(28.dp),
                    color = if (seat == Seat.ROW_1_LEFT) c.primaryContainer else c.surfaceVariant,
                    border = if (m != null && m.profileId == picked) androidx.compose.foundation.BorderStroke(3.dp, c.primary) else null) {
                    Column(Modifier.padding(16.dp).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                        if (m != null) Face(m.character, 80) else EmptySeat(80.dp)
                        Text(m?.name ?: "빈자리", fontSize = 28.sp, fontWeight = FontWeight.Bold)
                        Text(seat.label.replace("뒷자리", "뒤"), color = c.onSurfaceVariant)
                    }
                }
            }
        }
    }
    members.filter { it.seat == null }.takeIf { it.isNotEmpty() }?.let { Text("자리 없음: " + it.joinToString { m -> m.name }, color = c.onSurfaceVariant) }
}

@Composable
private fun InviteBody(g: CarGroup?, invite: GroupInvite?, copy: (String) -> Unit, link: () -> String, ctx: Context) {
    val c = MaterialTheme.colorScheme
    val guest = g?.kind == "guest"
    Heading(if (guest) "동승자 초대하기" else "가족 초대하기", "초대 코드와 링크를 만들었어요. 편한 방식으로 전달해 주세요.")
    if (invite == null) return
    Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
        CarCard(modifier = Modifier.weight(1f)) {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("초대 코드", color = c.onSurfaceVariant)
                Text(invite.code, fontSize = 34.sp, fontWeight = FontWeight.Bold)
                Ghost("코드 복사", true) { copy(invite.code) }
                val url = link()
                val matrix = remember(url) { QRCodeWriter().encode(url, BarcodeFormat.QR_CODE, 0, 0, mapOf(EncodeHintType.MARGIN to 2)) }
                Canvas(Modifier.size(260.dp).semantics { contentDescription = "초대 QR" }) {
                    drawRect(Color.White)
                    val unit = floor(size.minDimension / matrix.width).coerceAtLeast(1f)
                    val inset = (size.minDimension - matrix.width * unit) / 2
                    for (y in 0 until matrix.height) for (x in 0 until matrix.width) if (matrix[x, y]) drawRect(Color.Black, Offset(inset + x * unit, inset + y * unit), Size(unit, unit))
                }
                Text("QR로도 바로 참여할 수 있어요")
            }
        }
        Column(Modifier.weight(1.3f), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("초대 링크", fontSize = 30.sp, fontWeight = FontWeight.Bold)
            Row2(soft = true) { Column { Text("${g?.name ?: "우리 가족"} 초대 링크", fontSize = 30.sp, fontWeight = FontWeight.Bold); Text("열면 앱에서 ${invite.code} 그룹으로 연결") } }
            Primary("초대 링크 공유", true, Modifier.fillMaxWidth()) {
                // 2047:2279·2296 공유: 안드로이드 공유 화면(카카오톡·메시지 등)
                val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "${g?.name ?: "우리 가족"} 초대 ${invite.code}\n${link()}")
                ctx.startActivity(Intent.createChooser(send, "초대 링크 공유").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Ghost("링크 복사", true, Modifier.weight(1f)) { copy(link()) }
                Ghost("링크 열기", true, Modifier.weight(1f)) { runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } }
            }
            Text("코드 입력, QR 스캔, 초대 링크 모두\n같은 그룹으로 참여해요.", lineHeight = 34.sp)
        }
    }
}
