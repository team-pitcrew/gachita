package io.github.teampitcrew.gachita

import androidx.compose.runtime.DisposableEffect
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.rememberLauncherForActivityResult
import android.content.pm.PackageManager
import android.Manifest
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
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
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

/** 한 사람을 한 자리에 앉힌다(C14·C43). 그 자리에 다른 사람이 있으면 그 사람은 옮긴 사람의 원래 자리로(없었으면 자리 없음으로). 폰 groups.js와 같은 규칙. */
fun placeSeat(members: List<GroupMember>, profileId: String, seat: String?): List<GroupMember> {
    val from = members.firstOrNull { it.profileId == profileId }?.seat
    val other = seat?.let { s -> members.firstOrNull { it.seat == s && it.profileId != profileId } }
    return members.map { if (it.profileId == profileId) it.copy(seat = seat) else if (it.profileId == other?.profileId) it.copy(seat = from) else it }
}

/** 좌석 지도에서 누른 것: 사람(member, 그 사람의 자리 seat — 자리 없으면 null) 또는 빈자리(member 없음, seat). */
data class SeatPick(val member: String?, val seat: String?)

/** 좌석 바꾸기에서 누른 결과: 바뀐 자리(없으면 그대로), 다음에 고른 것, 부제. */
data class SeatResult(val members: List<GroupMember>?, val pick: SeatPick?, val note: String?)

/**
 * 좌석 바꾸기에서 누른 것(target: 자리 칸이면 seat이 있고 앉은 사람이면 member도, '자리 없음' 줄이면 member만).
 * 자리는 자리 칸을 눌러야만 정한다 — 사람(자리 없음 줄)을 누르면 고른 사람만 바뀐다. 사람 → 빈자리는 앉히고,
 * 앉은 사람 → 앉은 사람은 맞바꾼다. 자리 없는 사람은 앉은 사람의 자리에 넣지 않는다: 앉아 있던 사람이 자리를 잃으면
 * '이 가족과 출발'이 그 사람 없이 여행을 만든다(폰 #413 재점검). 폰 groups.js의 seatPick과 같은 규칙.
 */
fun seatPick(members: List<GroupMember>, pick: SeatPick?, target: SeatPick): SeatResult {
    fun name(id: String) = members.firstOrNull { it.profileId == id }?.name.orEmpty()
    fun seatOf(id: String) = members.firstOrNull { it.profileId == id }?.seat
    if (target.seat == null) return SeatResult(null, if (pick?.member == target.member) null else target, null) // 자리 없음 줄: 고르기만
    val who = pick?.member ?: return if (target.member != null) SeatResult(null, target, null) else SeatResult(null, null, "먼저 앉힐 사람을 눌러 주세요.")
    if (target.member == who) return SeatResult(null, null, null)
    val other = target.member
    if (other == null) { // 빈자리에 앉힘
        val n = name(who)
        return SeatResult(placeSeat(members, who, target.seat), null, "$n${if (batchim(n)) "을" else "를"} ${Seat.valueOf(target.seat).label.replace("뒷자리", "뒤")}에 앉혔어요.")
    }
    if (seatOf(who) != null) { // 앉은 사람끼리 맞바꿈
        val a = name(who)
        return SeatResult(swapSeats(members, who, other), null, "$a${if (batchim(a)) "과" else "와"} ${name(other)}의 자리 위치를 바꿨어요.")
    }
    return SeatResult(null, pick, "앉은 사람이 있는 자리예요. 빈자리를 눌러 주세요.") // 자리 없는 사람은 빈자리에만
}

/** 저장한 그룹에서 앉아 있다가 자리 없음이 되는 사람(저장을 막는다). */
fun lostSeats(saved: List<GroupMember>, edited: List<GroupMember>): List<GroupMember> {
    val before = saved.associate { it.profileId to it.seat }
    return edited.filter { before[it.profileId] != null && it.seat == null }
}

/** 저장한 그룹과 다른 자리만(PUT /groups/{id}/seats 본문). */
fun seatChanges(saved: List<GroupMember>, edited: List<GroupMember>): Map<String, String?> {
    val before = saved.associate { it.profileId to it.seat }
    return edited.filter { before[it.profileId] != it.seat }.associate { it.profileId to it.seat }
}

/**
 * 아이를 저장한 뒤 좌석 지도(C13)로 바로 갈지. 시안 시연 13→16: 첫 아이(서준) 뒤에는 가족 추가(C40 '서준까지 준비됐어요')로
 * 돌아가 다음 아이(하은)를 더하고, 아이가 둘 이상이 되면 좌석 지도로. 그 밖에는 '우리 가족 좌석 보기'로 언제든 간다.
 */
fun seatsAfterChild(members: List<GroupMember>) = members.count { it.role == "child" } >= 2

/** 아이 목소리 등록(C12·C42)의 읽을 문장. 받침에 따라 '서준이야'·'하은이야'·'지우야'(시안 글자). */
fun childLine(name: String) = "“나는 $name${if (batchim(name)) "이야" else "야"}. 바다에 가서 모래성을 만들 거야.”"

/** 우리 가족(C13) 아래 줄. */
fun readiness(members: List<GroupMember>): String {
    val consent = members.count { it.consent }
    val voice = members.count { it.hasVoice }
    return if (consent == members.size && voice == members.size) "녹음 동의 ${members.size}명 완료 / 목소리 등록 ${members.size}명 완료"
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

// ---- 그룹 화면(C16A groupDetail · C16B seatAssignment · C16C memberPicker · C16G guestDetail · C16I groupInvite · C16L groupsCreated) ----

/** 좌석 이름(ROW_2_LEFT)을 화면 글(뒤 왼쪽)로. 모르는 값이나 자리 없음은 null. */
fun seatLabel(seat: String?): String? = seat?.let { s -> Seat.entries.firstOrNull { it.name == s }?.label?.replace("뒷자리", "뒤") }

/** 좌석 배정(C16B)에 그리는 자리: 앞 둘, 뒤 둘(SeatGrid와 같음). */
val GRID_SEATS = listOf(listOf(Seat.ROW_1_LEFT, Seat.ROW_1_RIGHT), listOf(Seat.ROW_2_LEFT, Seat.ROW_2_RIGHT))

/** 동승 그룹에 만든 사람만 있을 때(C16G guestDetail, 전체 그룹의 '초대 대기'). 출발할 사람이 없어 초대부터 한다. */
fun soloGuest(g: CarGroup) = g.kind == "guest" && g.members.size <= 1

/** 그룹 카드의 둘째 줄(C16A·C16L): '4명  |  기본 그룹', 혼자인 동승 그룹에 쓸 수 있는 초대가 있으면 '1명  |  초대 대기'. */
fun groupLine(g: CarGroup): String =
    "${g.members.size}명  |  ${if (g.kind == "family") "기본 그룹" else if (soloGuest(g) && g.invite != null) "초대 대기" else "동승 그룹"}"

/** 전체 그룹(C16L) 순서: 가족 그룹이 먼저, 나머지는 서버가 준 순서. */
fun groupsInOrder(groups: List<CarGroup>) = groups.sortedBy { if (it.kind == "family") 0 else 1 }

/**
 * 구성원과 저장된 좌석(C16A): 자리 순서로 '운전석 → 아빠'. 자리 없는 구성원은 마지막 줄 하나('자리 없음 → 지우, 민수')로 모은다.
 * 서버는 자리가 정해진 구성원만 여행에 넣으므로(docs/api/groups.md) 자리 없음은 이번 여행에 타지 않는다는 뜻이다.
 */
fun seatLines(members: List<GroupMember>): List<Pair<String, String>> {
    val order = Seat.entries.map { it.name }
    val seated = members.filter { it.seat != null && it.seat in order }.sortedBy { order.indexOf(it.seat) }.map { seatLabel(it.seat)!! to it.name }
    val free = members.filter { it.seat == null || it.seat !in order }
    return if (free.isEmpty()) seated else seated + ("자리 없음" to free.joinToString(", ") { it.name })
}

/** 'Group / 2x2 profile' 칸 하나: 구성원 캐릭터, 지금 쓸 수 있는 초대(초대 중), 빈 칸(미등록). */
sealed interface FaceSlot {
    data class Member(val character: String) : FaceSlot
    data object Inviting : FaceSlot
    data object Empty : FaceSlot
}

/** 2x2 칸 넷(Group / 2x2 / one·two·three·inviting): 앞 네 사람, 자리가 남고 초대가 있으면 '초대 중' 한 칸, 나머지는 '미등록'. */
fun faceSlots(g: CarGroup): List<FaceSlot> {
    val faces: List<FaceSlot> = g.members.take(4).map { FaceSlot.Member(it.character) }
    val inviting = if (faces.size < 4 && g.invite != null) listOf(FaceSlot.Inviting) else emptyList()
    return (faces + inviting + List(4) { FaceSlot.Empty }).take(4)
}

/**
 * 좌석 구성원 선택(C16C)에서 seat 자리에 who를 고른 결과. 좌석 지도의 seatPick 규칙을 그대로 쓴다: 빈자리면 앉히고,
 * 앉은 사람끼리는 맞바꾸고('이미 앉은 사람을 선택하면 두 사람의 자리가 바뀌어요'), 자리 없는 사람은 앉은 사람의 자리에 넣지 않는다
 * — 앉아 있던 사람이 자리를 잃으면 '이 그룹과 출발'이 그 사람 없이 여행을 만든다. 그때 members는 null이고 note가 이유다.
 */
fun pickFor(members: List<GroupMember>, seat: String, who: String): SeatResult {
    val occupant = members.firstOrNull { it.seat == seat }?.profileId
    val r = seatPick(members, SeatPick(who, members.firstOrNull { it.profileId == who }?.seat), SeatPick(occupant, seat))
    if (r.members != null || r.note == null) return r
    val n = members.firstOrNull { it.profileId == who }?.name.orEmpty()
    return SeatResult(null, null, "$n${if (batchim(n)) "은" else "는"} 자리가 없어 앉은 사람과 바꿀 수 없어요. 빈자리를 골라 주세요.")
}

private enum class FamilyView { MEMBER, INVITE, CHILD, CHILD_VOICE, GROUP, SEAT, GUEST, GROUPS, DETAIL, ASSIGN, PICKER, GUEST_DETAIL, GROUP_INVITE }

/** 그룹 하나를 열 때의 화면: 혼자인 동승 그룹은 초대부터(C16G), 나머지는 구성원과 좌석(C16A). */
private fun detailOf(g: CarGroup?) = if (g != null && soloGuest(g)) FamilyView.GUEST_DETAIL else FamilyView.DETAIL

/** 옆 칸 없이 한 줄로 그리는 그룹 화면(C16*). FamilyFlow가 이 값들이면 따로 그린다. */
private val GROUP_VIEWS = setOf(FamilyView.GROUPS, FamilyView.DETAIL, FamilyView.ASSIGN, FamilyView.PICKER, FamilyView.GUEST_DETAIL, FamilyView.GROUP_INVITE)

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
    var voiceLevels by remember { mutableStateOf(DoubleArray(0)) } // 막대 칸마다 실제 들어온 소리 크기(VoiceMeter)
    var voiceState by remember { mutableStateOf("") } // recording · saving · saved · failed · blocked
    var voiceTry by remember { mutableStateOf(0) } // '다시 녹음'
    var seats by remember { mutableStateOf<List<GroupMember>>(emptyList()) }
    var pick by remember { mutableStateOf<SeatPick?>(null) }
    var seatNote by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf(false) }
    var guestName by remember { mutableStateOf("") }
    var myName by remember { mutableStateOf("민준") } // mock: 토큰이 없을 때의 시연 이름
    var pickSeat by remember { mutableStateOf(Seat.ROW_1_LEFT.name) } // 좌석 배정(C16B)에서 누른 자리 → 구성원 선택(C16C)

    val api = remember(server) { Server(server) }
    fun family() = groups.firstOrNull { it.kind == "family" }
    fun current() = groups.firstOrNull { it.id == groupId } ?: family()
    fun put(g: CarGroup) { groups = groups.filter { it.id != g.id } + g }
    // 요청 하나가 끝나기 전의 두 번째 누름은 버린다(C11을 빠르게 두 번 눌러 서준이 둘 생김). busy는 다시 그리기 전에도 막도록 따로 쥔다.
    val inFlight = remember { java.util.concurrent.atomic.AtomicBoolean(false) }
    fun act(work: suspend () -> Unit) {
        if (!inFlight.compareAndSet(false, true)) return
        busy = true; note = ""
        scope.launch {
            runCatching { work() }.onFailure { note = failureText(it) }
            busy = false
            inFlight.set(false)
        }
    }
    suspend fun <T> io(block: () -> T): T = withContext(Dispatchers.IO) { block() }
    suspend fun load() { if (token != null) { groups = io { api.groups(token) }; myName = io { api.profileName(token) } } }
    // 동승 그룹은 서버에서 자리 없이 시작한다. 시안(C15 '민준 / 운전석')대로 만든 사람(대표)을 운전석에 앉혀 저장한다.
    fun createGuest(): CarGroup {
        val made = api.createGroup(token!!, guestName.trim().ifBlank { "동승 그룹" }, "guest")
        val owner = made.members.firstOrNull { it.role == "owner" } ?: return made
        return api.saveSeats(token, made.id, mapOf(owner.profileId to Seat.ROW_1_LEFT.name))
    }
    // 아이 저장 뒤 갈 곳(seatsAfterChild): 아이가 둘 이상이면 좌석 지도(C13), 아니면 가족 추가(C40).
    fun afterChildSaved() {
        val fam = family()
        if (fam != null && seatsAfterChild(fam.members)) { groupId = fam.id; saved = false; view = FamilyView.GROUP } else view = FamilyView.MEMBER
    }
    suspend fun ensureFamily(): CarGroup = family() ?: io { api.createGroup(token!!, "우리 가족", "family") }.also { put(it) }
    suspend fun issue(g: CarGroup, to: FamilyView = FamilyView.INVITE) {
        groupId = g.id
        invite = if (token == null) g.invite else io { api.groupInvite(token, g.id) }
        view = to
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
            FamilyView.SEAT -> FamilyView.GROUP
            FamilyView.GUEST, FamilyView.DETAIL, FamilyView.GUEST_DETAIL -> FamilyView.GROUPS
            FamilyView.GROUPS -> { groupId = family()?.id; if (family() != null) FamilyView.GROUP else FamilyView.MEMBER }
            FamilyView.ASSIGN -> FamilyView.DETAIL
            FamilyView.PICKER -> FamilyView.ASSIGN
            FamilyView.GROUP_INVITE -> detailOf(current())
            // 좌석 지도에서 뒤로 가면 가족 추가(C40)로 — 아이를 더 더하거나 다시 초대한다.
            FamilyView.GROUP -> if (token != null) FamilyView.MEMBER else { onClose(); view }
            else -> { onClose(); view }
        }
    }
    // 아이 목소리 15초(C12·C42): 차 마이크로 15초(막대는 실제 소리 크기, VoiceMeter.kt) → Voice.kt embed → 값만
    // POST /groups/{id}/members/{profileId}/voice(보호자 토큰). 보호자 동의가 꺼진 아이는 녹음하지 않는다. 400(말소리 없음)은 다시 녹음.
    val mic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { if (it) voiceTry++ else { voiceState = "failed"; note = "마이크 권한이 없어 녹음할 수 없어요" } }
    DisposableEffect(view, child, voiceTry) {
        var rec: VoiceRecorder? = null
        val kid = child
        val gid = family()?.id
        if (view == FamilyView.CHILD_VOICE && kid != null && gid != null && token != null) {
            voiceSec = 0; voiceLevels = DoubleArray(0)
            when {
                !kid.consent -> { voiceState = "blocked"; note = "보호자 동의가 꺼져 있어 아이 목소리를 녹음하지 않아요" }
                ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED -> mic.launch(Manifest.permission.RECORD_AUDIO)
                else -> {
                    voiceState = "recording"
                    val meter = VoiceMeter(40)
                    rec = VoiceRecorder({ sec, level -> meter.add(sec, level); val snap = meter.snapshot(); scope.launch { voiceSec = minOf(15, sec.toInt()); voiceLevels = snap } }) { pcm, failed ->
                        scope.launch {
                            if (failed != null) { voiceState = "failed"; note = failed; return@launch }
                            voiceState = "saving"; voiceSec = 15
                            runCatching {
                                io {
                                    val v = embed(pcmSamples(pcm)) ?: throw ApiError(400, "소리가 너무 짧아요")
                                    AccountApi(server).childVoice(token, gid, kid.profileId, v, pcm.size / 2.0 / RATE)
                                }
                            }.onSuccess { voiceState = "saved" }
                                .onFailure { voiceState = "failed"; note = if (it is ApiError && it.status == 400) "말소리가 없어 등록할 수 없음" else failureText(it) }
                        }
                    }.also { it.start() }
                }
            }
        }
        onDispose { rec?.cancel() } // 화면을 떠나면 마이크를 놓고 모은 소리를 버린다
    }

    val g = current()
    if (view in GROUP_VIEWS) {
        // 그룹 화면(C16*): 옆 칸 없이 본문 하나와 아래 단추. 단추는 모두 docs/api/groups.md의 경로로 간다.
        val guest = g?.kind == "guest"
        // 전체 그룹을 열 때마다 다시 읽는다: 폰에서 초대로 들어온 사람, 다른 기기에서 바꾼 자리.
        LaunchedEffect(view) { if (view == FamilyView.GROUPS && token != null) runCatching { load() }.onFailure { note = failureText(it) } }
        GroupFrame(tabs = view != FamilyView.GROUP_INVITE, note = note, onClose = onClose, body = {
            when (view) {
                FamilyView.GROUPS -> {
                    Heading("내 동승 그룹", "함께 탈 그룹을 선택해 주세요.")
                    GroupList(groupsInOrder(groups)) { picked -> groupId = picked.id; view = detailOf(picked) }
                    // 새 그룹은 동승 그룹(C15)으로 만든다. 가족 그룹은 하나뿐이고 가족 추가(C40)에서 만든다.
                    Centered { Ghost("+ 새 그룹 만들기", !busy, Modifier.fillMaxWidth().height(96.dp)) { guestName = ""; view = FamilyView.GUEST } }
                }
                FamilyView.DETAIL -> {
                    Heading(g?.name ?: "우리 가족", if (guest) "오늘 함께 탈 사람과 좌석을 확인해 주세요." else "오늘 함께 탈 가족과 좌석을 확인해 주세요.")
                    if (g != null) GroupDetailBody(g)
                    Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                        Ghost("좌석 배정", !busy && g != null, Modifier.weight(1f).height(96.dp)) { seats = g!!.members; seatNote = null; view = FamilyView.ASSIGN }
                        Ghost("구성원 초대", !busy && g != null, Modifier.weight(1f).height(96.dp)) { act { issue(g!!, FamilyView.GROUP_INVITE) } }
                    }
                }
                FamilyView.ASSIGN -> {
                    Heading("좌석 배정", seatNote ?: "좌석을 누르고 앉을 사람을 선택해 주세요.")
                    SeatAssignBody(seats) { seat -> pickSeat = seat; view = FamilyView.PICKER }
                }
                FamilyView.PICKER -> {
                    Heading("누가 앉나요?", if (guest) "선택한 좌석에 앉을 사람을 골라 주세요." else "선택한 좌석에 앉을 가족을 골라 주세요.")
                    MemberPickerBody(seats, pickSeat) { m ->
                        val r = pickFor(seats, pickSeat, m.profileId)
                        if (r.members != null) { seats = r.members; seatNote = r.note; view = FamilyView.ASSIGN }
                        else if (r.note != null) toast(r.note)
                        else view = FamilyView.ASSIGN // 이미 그 자리에 앉은 사람
                    }
                }
                FamilyView.GUEST_DETAIL -> {
                    Heading(g?.name ?: "동승 그룹", "초대 코드, QR 또는 링크로 함께할 사람을 초대해 주세요.")
                    if (g != null) GuestDetailBody(g)
                    Primary("동승자 초대하기", !busy && g != null, Modifier.fillMaxWidth().height(96.dp)) { act { issue(g!!, FamilyView.GROUP_INVITE) } }
                }
                else -> InviteBody(g, invite, ::copy, ::link, ctx) // GROUP_INVITE(C16I)
            }
        }) {
            when (view) {
                FamilyView.GROUPS -> {
                    val fam = family()
                    Primary(if (fam != null) "우리 가족 보기" else "우리 가족 만들기", !busy, Modifier.weight(1f).height(96.dp)) {
                        if (fam != null) { groupId = fam.id; view = FamilyView.DETAIL } else view = FamilyView.MEMBER
                    }
                }
                FamilyView.DETAIL -> {
                    Ghost("전체 그룹", !busy, Modifier.weight(1f).height(96.dp)) { view = FamilyView.GROUPS }
                    // 서버는 자리가 정해진 구성원만 여행에 넣고 아무도 없으면 409다 — 앉힌 사람이 있을 때만 켠다.
                    Primary("이 그룹과 출발", !busy && token != null && g != null && g.members.any { it.seat != null }, Modifier.weight(1f).height(96.dp)) { g?.let { onStart(it.id) } }
                }
                FamilyView.ASSIGN -> {
                    Ghost("그룹으로", !busy, Modifier.weight(1f).height(96.dp)) { seatNote = null; view = FamilyView.DETAIL }
                    Primary("이 배치로 저장", !busy && token != null && g != null && seatChanges(g.members, seats).isNotEmpty() && lostSeats(g.members, seats).isEmpty(), Modifier.weight(1f).height(96.dp)) {
                        act { put(io { api.saveSeats(token!!, g!!.id, seatChanges(g.members, seats)) }); seatNote = null; view = FamilyView.DETAIL; toast("새 좌석을 저장했어요.") }
                    }
                }
                FamilyView.PICKER -> Ghost("좌석 배정으로", true, Modifier.weight(1f).height(96.dp)) { view = FamilyView.ASSIGN }
                FamilyView.GUEST_DETAIL -> Ghost("전체 그룹 보기", !busy, Modifier.weight(1f).height(96.dp)) { view = FamilyView.GROUPS }
                // 참여한 사람을 다시 읽고 그 그룹으로(혼자였던 동승 그룹에 누가 들어오면 C16A로).
                else -> Primary("그룹으로 돌아가기", !busy, Modifier.weight(1f).height(96.dp)) { act { load(); view = detailOf(current()) } }
            }
        }
        return
    }
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            AppBar("우리 가족", listening = false, "주차 중 · P" to true)
            if (view == FamilyView.GROUP || view == FamilyView.SEAT || view == FamilyView.GUEST) Tabs(onClose)
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                Column(Modifier.weight(1.6f), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    when (view) {
                        FamilyView.MEMBER -> {
                            val others = family()?.members.orEmpty().filter { it.name != myName && it.role != "owner" }
                            val kids = others.filter { it.role == "child" }
                            val adults = others.filter { it.role != "child" }
                            Heading(when { kids.isNotEmpty() -> "${kids.last().name}까지 준비됐어요"; adults.isNotEmpty() -> "${adults.last().name}${if (batchim(adults.last().name)) "이" else "가"} 함께해요"; else -> "우리 가족 추가" },
                                when { kids.isNotEmpty() -> "다음 아이를 추가해 주세요."; adults.isNotEmpty() -> "${adults.last().name} 계정 연결 완료 / 이제 아이를 추가해 주세요."; else -> "기존 계정 연결 또는 아이 프로필 직접 만들기" })
                            Row2(soft = true) { Face("glasses", 72); Column { Text(myName, fontSize = 30.sp, fontWeight = FontWeight.Bold); Text("내 계정 / 목소리 등록 완료", color = c.onSurfaceVariant) } }
                            (adults + kids).forEach { m -> Row2 { Face(m.character, 64); Column { Text(m.name, fontSize = 28.sp, fontWeight = FontWeight.Bold); Text(if (m.role == "child") "아이 프로필 / ${if (m.hasVoice) "목소리 등록 완료" else "목소리 등록 전"}" else "계정 연결 완료", color = c.onSurfaceVariant) } } }
                            Ghost("가족 계정 초대하기", !busy) { act { issue(ensureFamily()) } }
                            Ghost("아이 프로필 만들기", !busy) { view = FamilyView.CHILD }
                            // 자리 없는 구성원이 있으면 처음에 이 화면으로 열리므로, 좌석 지도로 가는 길을 둔다(폰과 같음).
                            if (family()?.members.orEmpty().size > 1) Ghost("우리 가족 좌석 보기", !busy) { groupId = family()?.id; saved = false; view = FamilyView.GROUP }
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
                            Heading("${name}의 목소리 등록", childLine(name))
                            Card2 {
                                Text("아이 목소리  $voiceSec / 15초", color = c.onSurfaceVariant)
                                // 지난 칸·지금 칸은 실제 들어온 소리 크기, 앞으로 칸은 시안처럼 낮은 막대(12dp).
                                val now = if (voiceState == "recording") minOf(40, voiceSec * 40 / 15) else if (voiceLevels.isEmpty()) -1 else 40
                                Row(Modifier.fillMaxWidth().height(96.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                                    repeat(40) { i -> Box(Modifier.weight(1f).height(if (i <= now) (12 + 72 * (voiceLevels.getOrNull(i) ?: 0.0)).toInt().dp else 12.dp).background(c.primary, RoundedCornerShape(3.dp))) }
                                }
                                Text("00:${voiceSec.toString().padStart(2, '0')}", color = c.onSurfaceVariant)
                            }
                            if (voiceState == "saved") Row2(soft = true) { Face(child?.character ?: childChar, 72); Column { Text("${name}의 프로필 준비 완료", fontSize = 28.sp, fontWeight = FontWeight.Bold); Text("다음 아이도 같은 방법으로 추가할 수 있어요.", color = c.onSurfaceVariant) } }
                        }
                        FamilyView.GROUP, FamilyView.SEAT -> {
                            val list = if (view == FamilyView.SEAT) seats else g?.members.orEmpty()
                            val guest = g?.kind == "guest"
                            Heading(if (view == FamilyView.SEAT) (if (guest) "동승 좌석 바꾸기" else "가족 좌석 바꾸기") else if (guest) g!!.name else "우리 가족",
                                if (view == FamilyView.SEAT) lostSeats(g?.members.orEmpty(), seats).takeIf { it.isNotEmpty() }?.let { lost -> "${lost.joinToString { it.name }}의 자리가 없어져요. 빈자리에 다시 앉혀 주세요." }
                                    ?: seatNote ?: if (pick == null) "사람을 누른 뒤 빈자리나 다른 사람을 눌러 주세요." else "빈자리나 바꿀 사람을 눌러 주세요."
                                else if (saved) "새 좌석을 저장했어요."
                                else if (list.none { it.seat != null }) "좌석을 눌러 자리를 정해 주세요."
                                else "${list.size}명 / ${if (guest) "동승 그룹" else "기본 그룹"} / 좌석을 눌러 변경")
                            // 사람과 빈자리, 자리 없는 구성원(차에서 만든 아이·초대로 들어온 성인·동승 그룹) 모두 누른다.
                            SeatGrid(list, if (view == FamilyView.SEAT) pick else null) { target ->
                                if (view == FamilyView.GROUP) { seats = list; pick = target.takeIf { it.member != null }; seatNote = null; saved = false; view = FamilyView.SEAT; return@SeatGrid }
                                val r = seatPick(seats, pick, target)
                                r.members?.let { seats = it }
                                pick = r.pick; seatNote = r.note
                            }
                            if (view == FamilyView.GROUP) Text(readiness(list), color = c.primary)
                        }
                        FamilyView.GUEST -> {
                            Heading("새 동승 그룹", "가족 외 동승자도 여행별로 함께할 수 있어요.")
                            Text("그룹 이름", color = c.onSurfaceVariant)
                            OutlinedTextField(guestName, { guestName = it.take(20) }, Modifier.fillMaxWidth(), singleLine = true, placeholder = { Text("주말 바다 친구들") })
                            Row2(soft = true) { Face("glasses", 72); Column { Text("내 계정", fontSize = 28.sp, fontWeight = FontWeight.Bold); Text("$myName / 운전석", color = c.onSurfaceVariant) } }
                            Ghost("계정 초대 링크 만들기", !busy && token != null) { act { val made = io { createGuest() }; put(made); issue(made, FamilyView.GROUP_INVITE) } }
                            Text("새 동승자는 본인이 동의한 뒤 그룹에 참여해요.", color = c.onSurfaceVariant)
                        }
                        else -> {} // 그룹 화면(C16*)은 위의 GroupFrame이 그린다
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
                            // 만든 뒤 이름 칸을 비워, 뒤로 와서 다시 눌러도 같은 아이가 또 생기지 않게 한다.
                            put(made); child = made.members.lastOrNull { it.role == "child" }; childName = ""; view = FamilyView.CHILD_VOICE
                        }
                    }
                    FamilyView.CHILD_VOICE -> when (voiceState) {
                        "saved", "blocked" -> Primary("가족 그룹에 저장", !busy, Modifier.weight(1f)) { act { load(); childName = ""; voiceState = ""; afterChildSaved() } }
                        "failed" -> Primary("다시 녹음", !busy, Modifier.weight(1f)) { note = ""; voiceTry++ }
                        else -> Primary(if (voiceState == "saving") "등록 중" else "녹음 중", false, Modifier.weight(1f)) {}
                    }
                    FamilyView.GROUP -> {
                        Ghost("전체 그룹", true, Modifier.weight(0.6f)) { view = FamilyView.GROUPS } // 전체 그룹(C16L)에서 새 동승 그룹을 만든다
                        // 서버는 자리가 정해진 구성원만 여행에 넣고 아무도 없으면 409다 — 앉힌 사람이 있을 때만 켠다.
                        Primary(if (g?.kind == "guest") "이 그룹과 출발" else "이 가족과 출발", !busy && token != null && g != null && g.members.any { it.seat != null }, Modifier.weight(1.4f)) { g?.let { onStart(it.id) } }
                    }
                    FamilyView.SEAT -> Primary("이 배치로 저장", !busy && token != null && g != null && seatChanges(g.members, seats).isNotEmpty() && lostSeats(g.members, seats).isEmpty(), Modifier.weight(1f)) {
                        act {
                            val changes = seatChanges(g!!.members, seats)
                            put(io { api.saveSeats(token!!, g.id, changes) }); saved = true; pick = null; view = FamilyView.GROUP
                        }
                    }
                    FamilyView.GUEST -> Primary("그룹 저장", !busy && token != null, Modifier.weight(1f)) {
                        act { val made = io { createGuest() }; put(made); groupId = made.id; saved = false; view = FamilyView.GUEST_DETAIL }
                    }
                    else -> {}
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
internal fun batchim(word: String): Boolean = word.trim().lastOrNull()?.let { it in '가'..'힣' && (it - '가') % 28 != 0 } ?: false

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
private fun SeatGrid(members: List<GroupMember>, pick: SeatPick?, onPick: (SeatPick) -> Unit) = CarCard {
    val c = MaterialTheme.colorScheme
    val at = members.filter { it.seat != null }.associateBy { it.seat }
    fun chosen(member: String?, seat: String?) = pick != null && (if (member != null) pick.member == member else pick.member == null && pick.seat == seat)
    Text("차량 앞쪽 ↑", color = c.onSurfaceVariant)
    listOf(listOf(Seat.ROW_1_LEFT, Seat.ROW_1_RIGHT), listOf(Seat.ROW_2_LEFT, Seat.ROW_2_RIGHT)).forEach { row ->
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            row.forEach { seat ->
                val m = at[seat.name]
                // 빈자리도 누른다: 자리 없는 사람을 앉히거나 앉은 사람을 옮긴다.
                Surface(Modifier.weight(1f).clickable { onPick(SeatPick(m?.profileId, seat.name)) }, RoundedCornerShape(28.dp),
                    color = if (seat == Seat.ROW_1_LEFT) c.primaryContainer else c.surfaceVariant,
                    border = if (chosen(m?.profileId, seat.name)) androidx.compose.foundation.BorderStroke(3.dp, c.primary) else null) {
                    Column(Modifier.padding(16.dp).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                        if (m != null) Face(m.character, 80) else EmptySeat(80.dp)
                        Text(m?.name ?: "빈자리", fontSize = 28.sp, fontWeight = FontWeight.Bold)
                        Text(seat.label.replace("뒷자리", "뒤"), color = c.onSurfaceVariant)
                    }
                }
            }
        }
    }
    // 자리 없는 구성원: 눌러 고른 뒤 빈자리(또는 앉은 사람)를 누른다.
    val free = members.filter { it.seat == null }
    if (free.isNotEmpty()) {
        Text("자리 없음", color = c.onSurfaceVariant)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            free.forEach { m ->
                Surface(Modifier.clickable { onPick(SeatPick(m.profileId, null)) }, RoundedCornerShape(36.dp), color = c.surfaceVariant,
                    border = if (chosen(m.profileId, null)) androidx.compose.foundation.BorderStroke(3.dp, c.primary) else null) {
                    Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Face(m.character, 48)
                        Text(m.name, fontSize = 26.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
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

// ---- 그룹 화면 조각(C16*). 색은 MaterialTheme.colorScheme만, 크기는 시안(1682×1210)의 값을 dp로. ----

/** 그룹 화면의 틀: 앱 바, 상위 탭(초대 화면 C16I에는 없음), 본문(넘치면 굴림), 아래 단추 줄, 알림. */
@Composable
private fun GroupFrame(tabs: Boolean, note: String, onClose: () -> Unit, body: @Composable ColumnScope.() -> Unit, bottom: @Composable RowScope.() -> Unit) {
    val c = MaterialTheme.colorScheme
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            AppBar("", listening = false, "주차 중  P" to true)
            if (tabs) Tabs(onClose)
            Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(20.dp), content = body)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(24.dp), content = bottom)
        }
        if (note.isNotEmpty()) Surface(Modifier.align(Alignment.BottomCenter).padding(bottom = 160.dp), RoundedCornerShape(24.dp), color = c.onSurface) {
            Text(note, Modifier.padding(horizontal = 48.dp, vertical = 24.dp), color = c.surface, fontSize = 26.sp, fontWeight = FontWeight.Bold)
        }
    }
}

/** 가운데 좁은 칸(전체 그룹 목록 1200/1602, 좌석 배치 1100/1602). */
@Composable
private fun Centered(fraction: Float = 0.75f, content: @Composable ColumnScope.() -> Unit) =
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        Column(Modifier.fillMaxWidth(fraction), verticalArrangement = Arrangement.spacedBy(20.dp), content = content)
    }

/** 'Character / 원본' 둥근 칸: 밝은 바탕 위에 전신 PNG를 키워 머리와 윗몸이 보이게(Theme.kt Avatar와 같은 자르기). */
@Composable
private fun Round(key: String, size: Int, shape: Shape = CircleShape) =
    Box(Modifier.size(size.dp).clip(shape).background(MaterialTheme.colorScheme.onSurface)) {
        Image(painterResource(charRes(key)), null,
            Modifier.fillMaxSize().graphicsLayer { scaleX = 1.45f; scaleY = 1.45f; transformOrigin = TransformOrigin(0.5f, 0.32f) },
            contentScale = ContentScale.Fit)
    }

/** 2x2 칸의 빈 칸: 점선 네모와 작은 글('미등록', 초대가 있으면 민트 '초대 중'). */
@Composable
private fun DashedSlot(label: String, color: Color, text: Color) =
    Box(Modifier.size(56.dp).drawBehind {
        drawRoundRect(color, cornerRadius = CornerRadius(16.dp.toPx()), style = Stroke(2.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(8f, 6f))))
    }, contentAlignment = Alignment.Center) { Text(label, color = text, fontSize = 13.sp, lineHeight = 18.sp) }

/** 'Group / 2x2 profile / Car'(2094:4293): 구성원 넷, 모자라면 초대 중·미등록 칸(2101:4827–4937). */
@Composable
private fun GroupFaces(g: CarGroup) {
    val c = MaterialTheme.colorScheme
    Surface(shape = RoundedCornerShape(28.dp), color = c.surfaceVariant) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            faceSlots(g).chunked(2).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { slot ->
                        when (slot) {
                            is FaceSlot.Member -> Round(slot.character, 56)
                            FaceSlot.Inviting -> DashedSlot("초대 중", c.primary, c.primary)
                            FaceSlot.Empty -> DashedSlot("미등록", c.outline, c.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
}

/** 그룹 얼굴: 두 사람 이상이면 2x2, 혼자면 큰 캐릭터 하나(C16G·C16L '주말 바다 친구들'). */
@Composable
private fun GroupAvatar(g: CarGroup) = if (g.members.size >= 2) GroupFaces(g) else Round(g.members.firstOrNull()?.character ?: "basic", 144, RoundedCornerShape(48.dp))

/** 전체 그룹 목록(C16L): 그룹 카드를 누르면 그 그룹으로. */
@Composable
private fun GroupList(groups: List<CarGroup>, onPick: (CarGroup) -> Unit) = Centered {
    val c = MaterialTheme.colorScheme
    groups.forEach { g ->
        Surface(Modifier.fillMaxWidth().clickable { onPick(g) }, RoundedCornerShape(28.dp), color = c.surface) {
            Row(Modifier.padding(28.dp), horizontalArrangement = Arrangement.spacedBy(24.dp), verticalAlignment = Alignment.CenterVertically) {
                GroupAvatar(g)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(if (g.members.size >= 2) 10.dp else 8.dp)) {
                    Text(g.name, fontSize = if (g.members.size >= 2) 40.sp else 32.sp, fontWeight = FontWeight.Bold, lineHeight = if (g.members.size >= 2) 50.sp else 42.sp)
                    Text(groupLine(g), color = c.onSurfaceVariant)
                    if (g.members.size >= 2) Text(g.members.joinToString(", ") { it.name }, color = c.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
    if (groups.isEmpty()) Text("아직 만든 그룹이 없어요.", color = c.onSurfaceVariant)
}

/** 그룹 상세(C16A): 그룹 프로필 카드와 구성원·저장된 좌석 카드. */
@Composable
private fun GroupDetailBody(g: CarGroup) {
    val c = MaterialTheme.colorScheme
    CarCard {
        Row(horizontalArrangement = Arrangement.spacedBy(24.dp), verticalAlignment = Alignment.CenterVertically) {
            GroupAvatar(g)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(g.name, fontSize = 40.sp, fontWeight = FontWeight.Bold, lineHeight = 50.sp)
                Text(groupLine(g), color = c.onSurfaceVariant)
            }
        }
    }
    CarCard(gap = 18.dp) {
        seatLines(g.members).forEach { (label, names) ->
            Row(Modifier.fillMaxWidth().height(54.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(label, Modifier.width(220.dp), color = c.onSurfaceVariant)
                Text(names, Modifier.weight(1f), fontSize = 28.sp, color = if (label == "자리 없음") c.onSurfaceVariant else c.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** 좌석 배정(C16B): 앞 둘·뒤 둘 칸. 칸을 누르면 그 자리에 앉을 사람을 고른다(C16C). 자리 없는 사람은 아래 한 줄로. */
@Composable
private fun SeatAssignBody(members: List<GroupMember>, onSeat: (String) -> Unit) {
    val c = MaterialTheme.colorScheme
    val at = members.filter { it.seat != null }.associateBy { it.seat }
    Centered(0.69f) {
        CarCard(gap = 20.dp) {
            Text("차량 앞쪽 ↑", Modifier.fillMaxWidth(), color = c.onSurfaceVariant, textAlign = TextAlign.Center)
            GRID_SEATS.forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                    row.forEach { seat ->
                        val m = at[seat.name]
                        Surface(Modifier.weight(1f).height(240.dp).clickable { onSeat(seat.name) }.semantics { contentDescription = "좌석 ${seatLabel(seat.name)}" }, RoundedCornerShape(28.dp), color = c.surfaceVariant) {
                            Column(Modifier.padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically)) {
                                if (m != null) Round(m.character, 88) else EmptySeat(88.dp)
                                Text(seatLabel(seat.name)!!, color = c.onSurfaceVariant)
                                Text(m?.name ?: "빈자리", fontSize = 32.sp, fontWeight = FontWeight.Bold, color = if (m != null) c.onSurface else c.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
        }
    }
    val free = members.filter { it.seat == null }
    if (free.isNotEmpty()) Text("자리 없음 · ${free.joinToString(", ") { it.name }}", Modifier.fillMaxWidth(), color = c.onSurfaceVariant, textAlign = TextAlign.Center)
    Text("이미 앉은 사람을 선택하면 두 사람의 자리가 바뀌어요.", Modifier.fillMaxWidth(), color = c.onSurfaceVariant, textAlign = TextAlign.Center)
}

/**
 * 좌석 구성원 선택(C16C): 고른 자리와 구성원 줄. 서버에 '오늘 탈 사람'이 따로 없어 자리로 정한다(자리 없음 = 이번 여행에 타지 않음).
 * 지금 그 자리의 사람은 민트 바탕, 자리 없는 사람은 그 자리가 비었을 때만 고를 수 있어 흐리게(누르면 이유를 알린다).
 */
@Composable
private fun MemberPickerBody(members: List<GroupMember>, seat: String, onPick: (GroupMember) -> Unit) {
    val c = MaterialTheme.colorScheme
    val occupied = members.any { it.seat == seat }
    CarCard {
        Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            Text("선택한 좌석", Modifier.weight(1f), color = c.onSurfaceVariant)
            Text(seatLabel(seat).orEmpty(), Modifier.weight(1f), fontSize = 32.sp, fontWeight = FontWeight.Bold)
        }
    }
    members.forEach { m ->
        val here = m.seat == seat
        val dim = occupied && m.seat == null
        Surface(Modifier.fillMaxWidth().clickable { onPick(m) }, RoundedCornerShape(28.dp), color = if (here) c.primaryContainer else c.surface) {
            Row(Modifier.padding(horizontal = 28.dp, vertical = 16.dp), horizontalArrangement = Arrangement.spacedBy(24.dp), verticalAlignment = Alignment.CenterVertically) {
                Round(m.character, 72)
                Text(m.name, Modifier.weight(1f), fontSize = 32.sp, fontWeight = FontWeight.Bold, color = if (dim) c.onSurfaceVariant else c.onSurface)
                Text(seatLabel(m.seat) ?: "자리 없음", color = c.onSurfaceVariant)
            }
        }
    }
}

/** 동승 그룹 상세(C16G): 만든 사람 캐릭터, 그룹 이름, '민준  |  운전석'. */
@Composable
private fun GuestDetailBody(g: CarGroup) {
    val c = MaterialTheme.colorScheme
    val owner = g.members.firstOrNull { it.role == "owner" } ?: g.members.firstOrNull()
    CarCard {
        Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            Round(owner?.character ?: "basic", 144, RoundedCornerShape(48.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(g.name, fontSize = 40.sp, fontWeight = FontWeight.Bold, lineHeight = 50.sp)
                Text("${owner?.name.orEmpty()}  |  ${seatLabel(owner?.seat) ?: "자리 없음"}", fontSize = 28.sp, color = c.onSurfaceVariant)
            }
        }
    }
}
