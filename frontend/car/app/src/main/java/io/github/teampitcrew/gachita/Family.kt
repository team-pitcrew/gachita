package io.github.teampitcrew.gachita

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
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
 * 가족·동승 그룹(흐름 F2, T133·T156): 원본 Figma '민준 개선안'의 C09–C16·C39–C43, 그룹 화면 C16A·B·C·G·I·L, 초대 링크 공유 시트(2047:2279·2296)와
 * '복사했어요' 알림(2047:2276). 서버 계약은 docs/api/groups.md. 주차 중에만 연다(Setup에서).
 * 화면은 CarDesign.kt 조각으로 조립한다: ParkedFrame(머리 줄·위 탭·아래 단추), TitleBlock, InfoCard, CarButton, CarField, CarToast, CarSheet.
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
        return SeatResult(swapSeats(members, who, other), null, "$a${if (batchim(a)) "과" else "와"} ${name(other)}의 ${if (seatOf(who)?.startsWith("ROW_2_") == true && target.seat.startsWith("ROW_2_")) "뒷자리" else "자리"} 위치를 바꿨어요.") // 시안 C14: 둘 다 뒷줄이면 '뒷자리'
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
 * 아이를 저장한 뒤 전체 그룹 목록(C16 groups)으로 바로 갈지. 시안 시연 13→16: 첫 아이(서준) 뒤에는 가족 추가(C40 '서준까지 준비됐어요')로
 * 돌아가 다음 아이(하은)를 더하고, 아이가 둘 이상이 되면 C42 '가족 그룹에 저장' → 전체 그룹 목록.
 */
fun seatsAfterChild(members: List<GroupMember>) = members.count { it.role == "child" } >= 2

/** 아이 목소리 등록(C12·C42)의 읽을 문장. 받침에 따라 '서준이야'·'하은이야'·'지우야'(시안 글자). */
fun childLine(name: String) = "“나는 $name${if (batchim(name)) "이야" else "야"}. 바다에 가서 모래성을 만들 거야.”"

/** 우리 가족 좌석(C43) 아래 줄(color/ok). */
fun readiness(members: List<GroupMember>): String {
    val consent = members.count { it.consent }
    val voice = members.count { it.hasVoice }
    return if (consent == members.size && voice == members.size) "동의와 목소리 등록 완료 / 다음 탑승부터 자동 기록 켜짐"
    else "녹음 동의 $consent/${members.size}명 / 목소리 등록 $voice/${members.size}명"
}

// ---- 그룹 화면(C16A groupDetail · C16B seatAssignment · C16C memberPicker · C16G guestDetail · C16I groupInvite · C16L groupsCreated) ----

/** 좌석 이름(ROW_2_LEFT)을 화면 글(뒤 왼쪽)로. 모르는 값이나 자리 없음은 null. */
fun seatLabel(seat: String?): String? = seat?.let { s -> Seat.entries.firstOrNull { it.name == s }?.label?.replace("뒷자리", "뒤") }

/**
 * 좌석 칸(C14·C43 SeatGrid, C16B SeatAssign): 시안은 앞 둘·뒤 둘. 폰 QR 참가·서버는 '뒤 가운데'(ROW_2_CENTER)도 받으므로
 * 그 자리에 앉은 사람이 있을 때만 뒤 가운데 칸을 더해 보이고 옮길 수 있게 한다(없으면 시안 그대로 2×2).
 */
fun gridSeats(members: List<GroupMember>): List<List<Seat>> = listOf(
    listOf(Seat.ROW_1_LEFT, Seat.ROW_1_RIGHT),
    if (members.any { it.seat == Seat.ROW_2_CENTER.name }) listOf(Seat.ROW_2_LEFT, Seat.ROW_2_CENTER, Seat.ROW_2_RIGHT) else listOf(Seat.ROW_2_LEFT, Seat.ROW_2_RIGHT),
)

/**
 * 출발 전에 자리 없는 구성원을 빈자리에 앉힌다(앞에서 뒤로, 왼쪽부터 · 뒤 가운데는 마지막). 서버는 자리가 정해진 구성원만 여행에 넣고,
 * 초대·QR로 들어온 사람은 자리 없이 들어오므로(C16A에는 앉은 사람만 보임) 그대로 출발하면 그 사람이 소리 없이 빠진다. 자리가 모자라면 남는다.
 */
fun autoSeats(members: List<GroupMember>): Map<String, String> {
    val taken = members.mapNotNull { it.seat }.toMutableSet()
    val free = listOf(Seat.ROW_1_LEFT, Seat.ROW_1_RIGHT, Seat.ROW_2_LEFT, Seat.ROW_2_RIGHT, Seat.ROW_2_CENTER).map { it.name }.filter { it !in taken }.iterator()
    return members.filter { it.seat == null }.mapNotNull { m -> if (free.hasNext()) m.profileId to free.next() else null }.toMap()
}

/**
 * 목소리를 아직 등록하지 않은 아이(보호자 동의가 켜진 아이만). 아이 프로필은 C11에서 먼저 만들고 C12에서 목소리를 올리므로, C12를 떠나거나
 * 앱이 닫히면 목소리 없는 아이가 남는다 — 가족 흐름을 열 때 그 아이의 C12부터 다시 연다(11/15 오너: 프로필을 만들 때 목소리 등록은 반드시).
 * 보호자 동의가 꺼진 아이는 녹음할 수 없어 예외.
 */
fun childWithoutVoice(g: CarGroup?): GroupMember? = g?.members?.firstOrNull { it.role == "child" && !it.hasVoice && it.consent }

/** 동승 그룹에 만든 사람만 있을 때(C16G guestDetail, 전체 그룹의 '초대 대기'). 출발할 사람이 없어 초대부터 한다. */
fun soloGuest(g: CarGroup) = g.kind == "guest" && g.members.size <= 1

/** 그룹 카드의 둘째 줄(C16A·C16L): '4명  |  기본 그룹', 혼자인 동승 그룹은 '1명  |  초대 대기'(시안 C16L, 그룹 저장 직후에도). */
fun groupLine(g: CarGroup): String =
    "${g.members.size}명  |  ${if (g.kind == "family") "기본 그룹" else if (soloGuest(g)) "초대 대기" else "동승 그룹"}"

/** 전체 그룹(C16L) 순서: 가족 그룹이 먼저, 나머지는 서버가 준 순서. */
fun groupsInOrder(groups: List<CarGroup>) = groups.sortedBy { if (it.kind == "family") 0 else 1 }

/** 구성원과 저장된 좌석(C16A): 자리 순서로 '운전석 → 아빠'. 자리 없는 구성원은 시안처럼 두지 않는다(자리는 C16B·C16C에서 정함). */
fun seatLines(members: List<GroupMember>): List<Pair<String, String>> {
    val order = Seat.entries.map { it.name }
    return members.filter { it.seat != null && it.seat in order }.sortedBy { order.indexOf(it.seat) }.map { seatLabel(it.seat)!! to it.name }
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

/** 2x2 칸 아래 줄(C09·C11·C12 '가족 그룹 미니 프로필', C10 제목 아래): '1명 등록 / 1명 초대 중 / 2명 미등록'. 없는 칸은 뺀다. */
fun slotLine(g: CarGroup): String {
    val slots = faceSlots(g)
    val inviting = slots.count { it == FaceSlot.Inviting }
    val empty = slots.count { it == FaceSlot.Empty }
    return listOfNotNull("${g.members.size}명 등록", "${inviting}명 초대 중".takeIf { inviting > 0 }, "${empty}명 미등록".takeIf { empty > 0 }).joinToString(" / ")
}

private enum class FamilyView { MEMBER, INVITE, CHILD, CHILD_VOICE, GROUP, SEAT, GUEST, GROUPS, DETAIL, ASSIGN, PICKER, GUEST_DETAIL, GROUP_INVITE }

/** 그룹 하나를 열 때의 화면: 혼자인 동승 그룹은 초대부터(C16G), 나머지는 구성원과 좌석(C16A). */
private fun detailOf(g: CarGroup?) = if (g != null && soloGuest(g)) FamilyView.GUEST_DETAIL else FamilyView.DETAIL

/** 위 탭이 없는 화면: 가족 추가·아이·목소리(C09–C12·C39–C42)와 가족 초대(C10·C16I). 동승 그룹 초대(C16)와 나머지는 탭이 있다. */
private fun tabless(view: FamilyView, guest: Boolean) =
    view == FamilyView.MEMBER || view == FamilyView.CHILD || view == FamilyView.CHILD_VOICE || view == FamilyView.INVITE || (!guest && view == FamilyView.GROUP_INVITE)

/** 프로필 메뉴에서 가족 흐름으로 바로 가는 곳: '동승 그룹 변경' → C16 groups, '좌석 배정' → C16B. */
enum class FamilyJump { GROUPS, SEATS }

/** 아이 목소리 파형(C12·C42 '파형'): 막대 64개, 폭 칸 나눔·간격 7, 높이 126 안. */
private const val CHILD_WAVE_BARS = 64

/** 그룹 카드 모서리(C16A·B·C·G·L, 미니 프로필 2094:5280): 28. 링크 카드(C10 '생성된 딥링크'): 16. CarShape에 아직 없어 여기 둔다. */
private val GroupShape = RoundedCornerShape(28.dp)
private val LinkShape = RoundedCornerShape(16.dp)

/** C14 제목줄 '동승자 수'(2131:6254): 시안 색 #ADC2B8(Theme 역할에 없음 — CarDesign.kt로 올릴 후보)과 19/26 Medium(시안은 Noto Sans KR, 앱 글꼴 Pretendard로). */
private val CountInk = Color(0xFFADC2B8)
private val CountText = CarText.Label.copy(fontSize = 19.sp, lineHeight = 26.sp)

private const val KAKAO = "com.kakao.talk"

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

/** 시안 'Character / 원본' 칸(모서리 48): 캐릭터가 칸을 채운다(Theme.kt CharAvatar). */
@Composable
private fun Face(key: String, size: Dp) = CharAvatar(charRes(key), size, CarShape.Face)

/**
 * 가족 흐름 전체. server는 API 주소, token은 이 차에 로그인한 프로필 토큰(없으면 시연 가족, mock).
 * onStart(groupId)는 '이 가족과 출발' — 부르는 쪽(MainActivity)이 POST /api/trips {groupId}로 여행을 만든다.
 * 머리 줄 오른쪽 위 '내 얼굴'은 TripHeader가 늘 그리고, 그 프로필 메뉴는 MainActivity가 띄운다. 메뉴의 '동승 그룹 변경'·'좌석 배정'은
 * [jump]로 들어와 C16 groups·C16B를 연다(처음 불러오기가 끝난 뒤). 연 뒤 [onJumped].
 */
@Composable
fun FamilyFlow(
    server: String, token: String?, onClose: () -> Unit, onStart: (String) -> Unit, jump: FamilyJump? = null, onJumped: () -> Unit = {},
    onTab: (Int) -> Unit = { onClose() },
) {
    // 로그인 전에는 가족 화면이 없다(시안은 C08 뒤에만). 부르는 쪽이 잘못 열면 바로 닫는다
    if (token == null) { LaunchedEffect(Unit) { onClose() }; return }
    val c = MaterialTheme.colorScheme
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var groups by remember { mutableStateOf(emptyList<CarGroup>()) }
    var groupId by remember { mutableStateOf<String?>(null) }
    var view by remember { mutableStateOf(FamilyView.MEMBER) }
    var invite by remember { mutableStateOf<GroupInvite?>(null) }
    var sharing by remember { mutableStateOf(false) } // 초대 링크 공유 시트(2047:2279·2296)
    var busy by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf("") }
    var childName by remember { mutableStateOf("") }
    var child by remember { mutableStateOf<GroupMember?>(null) }
    var voiceSec by remember { mutableStateOf(0) }
    var voiceLevels by remember { mutableStateOf(DoubleArray(0)) } // 막대 칸마다 실제 들어온 소리 크기(VoiceMeter)
    var voiceState by remember { mutableStateOf("") } // recording · saving · saved · failed · blocked
    var voiceTry by remember { mutableStateOf(0) } // '다시 녹음'
    var seats by remember { mutableStateOf<List<GroupMember>>(emptyList()) }
    var pick by remember { mutableStateOf<SeatPick?>(null) }
    var guestName by remember { mutableStateOf("") }
    var myName by remember { mutableStateOf("") }
    var myVoice by remember { mutableStateOf(true) } // C09 내 카드 '목소리 등록 완료'(읽기 전에는 시안 글)
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
    suspend fun load() { groups = io { api.groups(token) }; io { AccountApi(server).me(token) }.let { myName = it.name; myVoice = it.hasVoice } }
    // 동승 그룹은 서버에서 자리 없이 시작한다. 시안(C15 '민준 / 운전석')대로 만든 사람(대표)을 운전석에 앉혀 저장한다.
    fun createGuest(): CarGroup {
        val made = api.createGroup(token, guestName.trim().ifBlank { "동승 그룹" }, "guest")
        val owner = made.members.firstOrNull { it.role == "owner" } ?: return made
        return api.saveSeats(token, made.id, mapOf(owner.profileId to Seat.ROW_1_LEFT.name))
    }
    // 아이 저장 뒤 갈 곳(seatsAfterChild): 아이가 둘 이상이면 전체 그룹 목록(C42 → C16 groups), 아니면 가족 추가(C12 → C40).
    fun afterChildSaved() { view = if (family()?.members?.let(::seatsAfterChild) == true) FamilyView.GROUPS else FamilyView.MEMBER }
    suspend fun ensureFamily(): CarGroup = family() ?: io { api.createGroup(token, "우리 가족", "family") }.also { put(it) }
    suspend fun issue(g: CarGroup, to: FamilyView = FamilyView.INVITE) {
        groupId = g.id
        invite = io { api.groupInvite(token, g.id) }
        view = to
    }
    fun toast(text: String) { note = text }
    // '이 그룹과 출발'(C16A·C43): 자리 없는 구성원을 빈자리에 앉혀 저장한 뒤 여행을 만든다(autoSeats)
    fun depart(g: CarGroup) = act { val add = autoSeats(g.members); if (add.isNotEmpty()) put(io { api.saveSeats(token, g.id, add) }); onStart(g.id) }
    LaunchedEffect(note) { if (note.isNotEmpty()) { delay(toastMs(note)); note = "" } } // 2047:2276 알림(복사 1.5초, 원본에 없는 오류 글 3초)
    fun link() = server.trimEnd('/') + (invite?.url ?: "")
    fun copy(text: String) {
        (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("가치타 초대", text))
        toast("복사했어요") // 2047:2276
    }

    LaunchedEffect(token) {
        busy = true
        runCatching { load() }.onFailure { note = failureText(it) }
        val members = family()?.members.orEmpty()
        val silent = childWithoutVoice(family())
        if (silent != null) { child = silent; voiceState = "" }
        view = when {
            silent != null -> FamilyView.CHILD_VOICE // 목소리 없이 남은 아이: 그 아이의 C12부터
            members.size > 1 && members.all { it.seat != null } -> FamilyView.GROUP
            family() == null && groups.isNotEmpty() -> FamilyView.GROUPS // 동승 그룹만 있는 계정(PITCREW 등)은 가족 추가가 아니라 그룹 목록
            else -> FamilyView.MEMBER
        }
        busy = false
    }
    // 전체 그룹을 열 때마다 다시 읽는다: 폰에서 초대로 들어온 사람, 다른 기기에서 바꾼 자리.
    LaunchedEffect(view) { if (view == FamilyView.GROUPS) runCatching { load() }.onFailure { note = failureText(it) } }
    LaunchedEffect(jump, busy) {
        if (jump == null || busy) return@LaunchedEffect // 처음 불러오기(LaunchedEffect(token))가 정한 화면 뒤에 연다
        if (jump == FamilyJump.SEATS) { val now = current(); groupId = now?.id; seats = now?.members.orEmpty(); view = FamilyView.ASSIGN } else view = FamilyView.GROUPS
        onJumped()
    }
    BackHandler {
        if (sharing) { sharing = false; return@BackHandler }
        view = when (view) {
            FamilyView.INVITE, FamilyView.CHILD -> FamilyView.MEMBER
            // C12·C42: 아이 프로필은 이미 만들어졌다 — 목소리를 올리기(또는 동의가 꺼져 녹음할 수 없음) 전에는 떠나지 않는다(시안에 건너뛰기 없음)
            FamilyView.CHILD_VOICE -> if (voiceState == "saved" || voiceState == "blocked") FamilyView.MEMBER else FamilyView.CHILD_VOICE
            FamilyView.SEAT -> FamilyView.GROUP
            FamilyView.GUEST, FamilyView.DETAIL, FamilyView.GUEST_DETAIL -> FamilyView.GROUPS
            FamilyView.GROUPS -> { groupId = family()?.id; if (family() != null) FamilyView.GROUP else { onClose(); view } }
            FamilyView.ASSIGN -> FamilyView.DETAIL
            FamilyView.PICKER -> FamilyView.ASSIGN
            FamilyView.GROUP_INVITE -> detailOf(current())
            // 좌석 지도에서 뒤로 가면 가족 추가(C40)로 — 아이를 더 더하거나 다시 초대한다.
            FamilyView.GROUP -> FamilyView.MEMBER
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
        if (view == FamilyView.CHILD_VOICE && kid != null && gid != null) {
            voiceSec = 0; voiceLevels = DoubleArray(0)
            when {
                !kid.consent -> { voiceState = "blocked"; note = "보호자 동의가 꺼져 있어 아이 목소리를 녹음하지 않아요" }
                ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED -> mic.launch(Manifest.permission.RECORD_AUDIO)
                else -> {
                    voiceState = "recording"
                    val meter = VoiceMeter(CHILD_WAVE_BARS)
                    rec = VoiceRecorder({ sec, level -> meter.add(sec, level); val snap = meter.snapshot(); scope.launch { voiceSec = minOf(15, sec.toInt()); voiceLevels = snap } }) { pcm, failed ->
                        scope.launch {
                            if (failed != null) { voiceState = "failed"; note = failed; return@launch }
                            voiceState = "saving"; voiceSec = 15
                            runCatching {
                                io {
                                    val v = embed(pcmSamples(pcm)) ?: throw ApiError(400, "소리가 너무 짧아요")
                                    AccountApi(server).childVoice(token, gid, kid.profileId, v, pcm.size / 2.0 / RATE)
                                    runCatching { strongBody(ctx, pcm)?.let { AccountApi(server).childStrongVoice(token, gid, kid.profileId, it) } } // 둘째 값(강한 화자 값)도 올린다. 실패해도 등록은 된 것
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
    val guest = g?.kind == "guest"
    val fam = family()
    // 내 계정 카드(C09·C15)의 캐릭터: 가족 그룹에서 내 이름(없으면 대표)의 캐릭터. 그룹이 아직 없으면 시안의 안경.
    val me = fam?.members?.let { ms -> ms.firstOrNull { it.name == myName } ?: ms.firstOrNull { it.role == "owner" } }
    val myChar = me?.character?.takeIf { it.isNotEmpty() } ?: "glasses"
    // 오른쪽 '가족 그룹 미니 프로필'(C09·C11·C12만 — C39–C42에는 없다). 가족 그룹이 아직 없으면 나 혼자인 칸. 초대 중 칸은 초대 화면(C10)에만.
    val mini = fam?.copy(invite = null) ?: CarGroup("", "우리 가족", "family", listOf(GroupMember("", myName, myChar, true, true, "owner", null)), null)
    val side: @Composable () -> Unit = { MiniProfile(mini) }
    val kidCount = fam?.members.orEmpty().count { it.role == "child" }
    val childChar = CHARS[kidCount % CHARS.size] // 시안 C11 '캡모자 서준'(첫째), C41 '기본 하은'(둘째)

    ParkedFrame(
        // 위 탭: '함께 타는 중'은 진행 중인 여행이 있으면 C17(MainActivity가 닫아 준다), 없으면 전체 그룹 목록(C16 groups). 나머지는 여행 화면의 그 탭으로.
        tab = if (tabless(view, guest)) null else 0, onTab = { if (it == 0) view = FamilyView.GROUPS; onTab(it) },
        overlay = { CarToast(note) },
        bottom = {
            when (view) {
                FamilyView.MEMBER -> {
                    val adult = fam?.members.orEmpty().any { it.role == "adult" }
                    CarButton(if (adult) "아이 프로필 만들기" else "계속", Modifier.weight(1f), enabled = !busy) { // C09 2300:5616 '계속' → C10
                        if (adult) view = FamilyView.CHILD else act { issue(ensureFamily()) }
                    }
                }
                // 시안 '엄마 참여 확인' — 초대받는 사람의 이름은 참여 전에는 알 수 없다.
                FamilyView.INVITE -> CarButton("참여 확인", Modifier.weight(1f), enabled = !busy) {
                    act { val before = family()?.members?.size ?: 0; load(); if ((family()?.members?.size ?: 0) > before) view = FamilyView.MEMBER else toast("아직 참여한 가족이 없어요") }
                }
                FamilyView.CHILD -> CarButton("동의하고 목소리 등록", Modifier.weight(1f), enabled = !busy && childName.isNotBlank()) {
                    act {
                        val home = ensureFamily()
                        // '동의하고 목소리 등록': 보호자가 화면의 동의 문장(C11)에 동의하고 누른다.
                        val made = io { api.addChild(token, home.id, childName.trim(), childChar, true) }
                        // 만든 뒤 이름 칸을 비워, 뒤로 와서 다시 눌러도 같은 아이가 또 생기지 않게 한다.
                        put(made); child = made.members.lastOrNull { it.role == "child" }; childName = ""; view = FamilyView.CHILD_VOICE
                    }
                }
                FamilyView.CHILD_VOICE -> when (voiceState) {
                    "saved", "blocked" -> CarButton("가족 그룹에 저장", Modifier.weight(1f), enabled = !busy) { act { load(); childName = ""; voiceState = ""; afterChildSaved() } }
                    "failed" -> CarButton("다시 녹음", Modifier.weight(1f), enabled = !busy) { note = ""; voiceTry++ }
                    else -> CarButton(if (voiceState == "saving") "등록 중" else "녹음 중", Modifier.weight(1f), enabled = false) {}
                }
                FamilyView.GROUP -> {
                    CarButton("새 동승 그룹", Modifier.width(440.dp), CarButtonKind.Secondary, enabled = !busy) { guestName = ""; view = FamilyView.GUEST }
                    // 서버는 자리가 정해진 구성원만 여행에 넣고 아무도 없으면 409다 — 앉힌 사람이 있을 때만 켠다.
                    CarButton(if (guest) "이 그룹과 출발" else "이 가족과 출발", Modifier.weight(1f), enabled = !busy && g != null && g.members.isNotEmpty()) { g?.let { depart(it) } }
                }
                FamilyView.SEAT -> CarButton("이 배치로 저장", Modifier.weight(1f), enabled = !busy && g != null && seatChanges(g.members, seats).isNotEmpty() && lostSeats(g.members, seats).isEmpty()) {
                    act { put(io { api.saveSeats(token, g!!.id, seatChanges(g.members, seats)) }); pick = null; view = FamilyView.GROUP }
                }
                FamilyView.GUEST -> CarButton("그룹 저장", Modifier.weight(1f), enabled = !busy) {
                    act { val made = io { createGuest() }; put(made); view = FamilyView.GROUPS } // C15 → C16L
                }
                FamilyView.GROUPS -> CarButton("우리 가족 보기", Modifier.weight(1f), enabled = !busy) { // 가족 그룹이 없으면 가족 추가(C09)부터
                    if (fam != null) { groupId = fam.id; view = FamilyView.DETAIL } else view = FamilyView.MEMBER
                }
                FamilyView.DETAIL -> {
                    CarButton("전체 그룹", Modifier.weight(1f), CarButtonKind.Secondary, enabled = !busy) { view = FamilyView.GROUPS }
                    // 서버는 자리가 정해진 구성원만 여행에 넣고 아무도 없으면 409다 — 앉힌 사람이 있을 때만 켠다.
                    CarButton("이 그룹과 출발", Modifier.weight(1f), enabled = !busy && g != null && g.members.isNotEmpty()) { g?.let { depart(it) } }
                }
                FamilyView.ASSIGN -> {
                    CarButton("그룹으로", Modifier.weight(1f), CarButtonKind.Secondary, enabled = !busy) { view = FamilyView.DETAIL }
                    CarButton("이 배치로 저장", Modifier.weight(1f), enabled = !busy && g != null && seatChanges(g.members, seats).isNotEmpty() && lostSeats(g.members, seats).isEmpty()) {
                        act { put(io { api.saveSeats(token, g!!.id, seatChanges(g.members, seats)) }); view = FamilyView.DETAIL }
                    }
                }
                FamilyView.PICKER -> CarButton("좌석 배정으로", Modifier.weight(1f), CarButtonKind.Secondary) { view = FamilyView.ASSIGN }
                FamilyView.GUEST_DETAIL -> CarButton("전체 그룹 보기", Modifier.weight(1f), CarButtonKind.Secondary, enabled = !busy) { view = FamilyView.GROUPS }
                // 참여한 사람을 다시 읽고 그 그룹으로(혼자였던 동승 그룹에 누가 들어오면 C16A로).
                FamilyView.GROUP_INVITE -> CarButton("그룹으로 돌아가기", Modifier.weight(1f), enabled = !busy) { act { load(); view = detailOf(current()) } }
            }
        },
    ) {
        when (view) {
            FamilyView.MEMBER -> { // C09 · C39 · C40
                val others = fam?.members.orEmpty().filter { it.name != myName && it.role != "owner" }
                val kids = others.filter { it.role == "child" }
                val adults = others.filter { it.role != "child" }
                TitleBlock(when { kids.isNotEmpty() -> "${kids.last().name}까지 준비됐어요"; adults.isNotEmpty() -> "${adults.last().name}${if (batchim(adults.last().name)) "이" else "가"} 함께해요"; else -> "우리 가족 추가" },
                    when { kids.isNotEmpty() -> "${(listOf(myName) + adults.map { it.name } + kids.map { it.name }).joinToString(", ")} 준비 완료 / 다음 아이를 추가해 주세요."; adults.isNotEmpty() -> "${adults.last().name} 계정 연결 완료 / 이제 아이를 추가해 주세요."; else -> "기존 계정 연결 또는 아이 프로필 직접 만들기" })
                // 시안의 '아빠 민준'·'엄마의 계정 초대하기'처럼 호칭이 든 글은 아빠·엄마를 고정하지 않는다(11/15 오너 "초대하기로 바꿔"): 이름, 초대는 '초대하기'.
                Body(side = side.takeIf { others.isEmpty() }) {
                    InfoCard(myName, if (myVoice) "내 계정 / 목소리 등록 완료" else "내 계정 / 목소리 미등록", soft = true, face = charRes(myChar))
                    CarButton("초대하기", kind = CarButtonKind.Secondary, enabled = !busy) { act { issue(ensureFamily()) } }
                    CarButton("아이 프로필 만들기", kind = CarButtonKind.Secondary, enabled = !busy) { view = FamilyView.CHILD }
                    InfoCard("가족 그룹은 한 번만", "저장한 구성원과 좌석을 다음 여행에도 사용")
                }
            }
            FamilyView.INVITE, FamilyView.GROUP_INVITE -> { // C10 · C16 · C16I
                InviteTitle(g?.copy(invite = invite), counted = view == FamilyView.INVITE)
                InviteBody(g, invite, ::copy, ::link, ctx, { sharing = true }, Modifier.weight(1f))
            }
            FamilyView.CHILD -> { // C11 · C41
                TitleBlock("아이 프로필 만들기", "보호자가 이름과 캐릭터, 목소리를 관리해요.")
                Body(side = side.takeIf { kidCount == 0 }) {
                    CarField("아이 이름", childName, { childName = it.take(20) }, KeyboardType.Text, placeholder = "서준")
                    // 아이 캐릭터: surface, 여백 20, 간격 24, 캐릭터 140, Headline. 시안처럼 누름 없이 아이 순서대로(childChar).
                    Surface(Modifier.fillMaxWidth(), CarShape.Card, color = c.surface) {
                        Row(Modifier.padding(20.dp), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                            Face(childChar, 140.dp)
                            Text("${CHAR_LABEL[childChar.removeSuffix("-small")] ?: ""} $childName".trim(), style = CarText.Headline)
                        }
                    }
                    InfoCard("아이 목소리 15초 등록", "아이에게 짧은 문장을 읽어 달라고 해주세요.")
                    Text("보호자로서 아이의 녹음과 콘텐츠 처리에 동의해요.", style = CarText.Label, color = c.onSurfaceVariant)
                }
            }
            FamilyView.CHILD_VOICE -> { // C12 · C42
                val name = child?.name ?: childName.ifBlank { "아이" }
                TitleBlock("${name}의 목소리 등록", childLine(name))
                Body(side = side.takeIf { kidCount <= 1 }) {
                    Surface(Modifier.fillMaxWidth(), CarShape.Card, color = c.surface) {
                        Column(Modifier.padding(28.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
                            Text("아이 목소리  $voiceSec / 15초", style = CarText.Label, color = c.onSurfaceVariant)
                            // 지난 칸·지금 칸은 실제 들어온 소리 크기, 앞으로 칸은 낮은 막대(10).
                            Waveform(voiceLevels, if (voiceState == "recording") minOf(CHILD_WAVE_BARS, voiceSec * CHILD_WAVE_BARS / 15) else if (voiceLevels.isEmpty()) -1 else CHILD_WAVE_BARS)
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("00:${voiceSec.toString().padStart(2, '0')}", style = CarText.Label, color = c.onSurfaceVariant)
                                Text("00:15", style = CarText.Label, color = c.onSurfaceVariant)
                            }
                        }
                    }
                    if (voiceState == "saved") {
                        val members = fam?.members.orEmpty()
                        InfoCard("${name}의 프로필 준비 완료", if (seatsAfterChild(members)) "우리 가족 ${members.size}명의 프로필이 모두 준비됐어요." else "다음 아이도 같은 방법으로 추가할 수 있어요.",
                            soft = true, face = charRes(child?.character ?: childChar))
                    }
                }
            }
            FamilyView.GROUP, FamilyView.SEAT -> { // C43 저장된 새 좌석 · C14 가족 좌석 바꾸기
                val list = if (view == FamilyView.SEAT) seats else g?.members.orEmpty()
                if (view == FamilyView.SEAT) SeatTitle(g)
                else TitleBlock(g?.name ?: "우리 가족", "${list.size}명 / ${if (guest) "동승 그룹" else "기본 그룹"} / 좌석을 눌러 변경")
                Body {
                    // 좌석을 누르면 좌석 바꾸기(C14)에서 그 사람을 고른 채로 연다. C14에서는 고른 사람 → 빈자리면 앉히고, 앉은 사람끼리는 맞바꾼다.
                    SeatGrid(list) { target ->
                        if (view == FamilyView.GROUP) { seats = list; pick = target.takeIf { it.member != null }; view = FamilyView.SEAT; return@SeatGrid }
                        val r = seatPick(seats, pick, target)
                        r.members?.let { seats = it }
                        pick = r.pick
                        if (r.members == null && r.note != null) toast(r.note) // 바꿀 수 없는 누름은 이유만 알린다
                    }
                    if (view == FamilyView.GROUP) Text(readiness(list), style = CarText.Label, color = c.tertiary) // 시안 color/ok
                }
            }
            FamilyView.GUEST -> { // C15
                TitleBlock("새 동승 그룹", "가족 외 동승자도 여행별로 함께할 수 있어요.")
                Body {
                    CarField("그룹 이름", guestName, { guestName = it.take(20) }, KeyboardType.Text, placeholder = "주말 바다 친구들")
                    InfoCard("내 계정", "$myName / 운전석", soft = true, face = charRes(myChar))
                    CarButton("계정 초대 링크 만들기", kind = CarButtonKind.Secondary, enabled = !busy) {
                        act { val made = io { createGuest() }; put(made); issue(made, FamilyView.GROUP_INVITE) }
                    }
                    Text("새 동승자는 본인이 동의한 뒤 그룹에 참여해요.", style = CarText.Label, color = c.onSurfaceVariant)
                }
            }
            FamilyView.GROUPS -> { // C16L
                TitleBlock("내 동승 그룹", "함께 탈 그룹을 선택해 주세요.")
                Body(width = 1200.dp, gap = 20.dp) {
                    groupsInOrder(groups).forEach { one -> GroupCard(one, names = true) { groupId = one.id; view = detailOf(one) } }
                    // 새 그룹은 동승 그룹(C15)으로 만든다. 가족 그룹은 하나뿐이고 가족 추가(C40)에서 만든다.
                    CarButton("+ 새 그룹 만들기", kind = CarButtonKind.Secondary, enabled = !busy) { guestName = ""; view = FamilyView.GUEST }
                }
            }
            FamilyView.DETAIL -> { // C16A
                TitleBlock(g?.name ?: "우리 가족", if (guest) "오늘 함께 탈 사람과 좌석을 확인해 주세요." else "오늘 함께 탈 가족과 좌석을 확인해 주세요.")
                Body(width = Dp.Unspecified) {
                    if (g != null) { GroupCard(g, names = false); SeatLines(g.members) }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                        CarButton("좌석 배정", Modifier.weight(1f), CarButtonKind.Secondary, enabled = !busy && g != null) { seats = g!!.members; view = FamilyView.ASSIGN }
                        CarButton("구성원 초대", Modifier.weight(1f), CarButtonKind.Secondary, enabled = !busy && g != null) { act { issue(g!!, FamilyView.GROUP_INVITE) } }
                    }
                }
            }
            FamilyView.ASSIGN -> { // C16B
                TitleBlock("좌석 배정", "좌석을 누르고 앉을 사람을 선택해 주세요.")
                Body(width = 1100.dp) { SeatAssign(seats) { seat -> pickSeat = seat; view = FamilyView.PICKER } }
            }
            FamilyView.PICKER -> { // C16C
                TitleBlock("누가 앉나요?", if (guest) "선택한 좌석에 앉을 사람을 골라 주세요." else "선택한 좌석에 앉을 가족을 골라 주세요.")
                Body(width = Dp.Unspecified) {
                    MemberPicker(seats, pickSeat) { m ->
                        val r = pickFor(seats, pickSeat, m.profileId)
                        if (r.members != null) { seats = r.members; view = FamilyView.ASSIGN }
                        else if (r.note != null) toast(r.note)
                        else view = FamilyView.ASSIGN // 이미 그 자리에 앉은 사람
                    }
                }
            }
            FamilyView.GUEST_DETAIL -> { // C16G
                TitleBlock(g?.name ?: "동승 그룹", "초대 코드, QR 또는 링크로 함께할 사람을 초대해 주세요.")
                Body(width = Dp.Unspecified) {
                    if (g != null) GuestCard(g)
                    CarButton("동승자 초대하기", enabled = !busy && g != null) { act { issue(g!!, FamilyView.GROUP_INVITE) } }
                }
            }
        }
    }
    val inv = invite
    if (sharing && inv != null) ShareSheet(g?.name ?: "우리 가족", inv.code, link(), ctx, { copy(link()) }) { sharing = false }
}

private val CHARS = listOf("cap", "basic-small", "glasses", "travel", "game", "healing", "camping", "sport", "pet", "office")
private val CHAR_LABEL = mapOf("basic" to "기본", "cap" to "캡모자", "glasses" to "안경", "travel" to "여행", "game" to "게임", "sport" to "운동", "pet" to "반려동물", "camping" to "캠핑", "office" to "직장인", "healing" to "힐링")
internal fun batchim(word: String): Boolean = word.trim().lastOrNull()?.let { it in '가'..'힣' && (it - '가') % 28 != 0 } ?: false

// ---- 화면 조각. 색은 MaterialTheme.colorScheme 역할만, 글자는 CarText, 크기는 시안(1682×1210)의 값을 dp로. ----

/**
 * 시안 '본문'(가운데 맞춤): 가운데 width 폭 칸(C09–C15 988, C16L 1200, C16B 1100, C16A·C·G 전체 폭)이 넘치면 굴리고,
 * side(가족 그룹 미니 프로필 320)가 있으면 간격 24로 옆에 붙인다.
 */
@Composable
private fun ColumnScope.Body(width: Dp = 988.dp, gap: Dp = 24.dp, side: (@Composable () -> Unit)? = null, content: @Composable ColumnScope.() -> Unit) =
    Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(24.dp, Alignment.CenterHorizontally)) {
        Column(Modifier.weight(1f, fill = false).widthIn(max = width).fillMaxHeight().verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(gap), content = content)
        side?.invoke()
    }

/** 2x2 칸의 빈 칸(2101:4834·4840): 점선 네모(line 또는 accent, 2)와 작은 글('미등록', 초대가 있으면 accent '초대 중'). */
@Composable
private fun DashedSlot(label: String, line: Color, text: Color, scale: Float) =
    Box(Modifier.size(56.dp * scale).drawBehind {
        drawRoundRect(line, cornerRadius = CornerRadius((16 * scale).dp.toPx()), style = Stroke((2 * scale).dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(8f * scale, 6f * scale))))
    }, contentAlignment = Alignment.Center) {
        // 시안 Phone/Caption 13(Regular 13/18) — CarText에 없는 크기라 Label을 줄여 쓴다.
        Text(label, color = text, style = CarText.Label.copy(fontWeight = FontWeight.Normal, fontSize = 13.sp * scale, lineHeight = 18.sp * scale), textAlign = TextAlign.Center)
    }

/** 'Group / 2x2 / … / Car'(2094:4293, surface-2·모서리 28·여백 12·간격 8·칸 56). scale 2/3은 C10 제목 옆 'Badge'(2101:4959). */
@Composable
private fun GroupFaces(g: CarGroup, scale: Float = 1f) {
    val c = MaterialTheme.colorScheme
    Surface(shape = RoundedCornerShape(28.dp * scale), color = c.surfaceVariant) {
        Column(Modifier.padding(12.dp * scale), verticalArrangement = Arrangement.spacedBy(8.dp * scale)) {
            faceSlots(g).chunked(2).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp * scale)) {
                    row.forEach { slot ->
                        when (slot) {
                            is FaceSlot.Member -> Face(slot.character, 56.dp * scale)
                            FaceSlot.Inviting -> DashedSlot("초대 중", c.primary, c.primary, scale)
                            FaceSlot.Empty -> DashedSlot("미등록", c.outlineVariant, c.onSurfaceVariant, scale)
                        }
                    }
                }
            }
        }
    }
}

/** '가족 그룹 미니 프로필'(C09·C11·C12, surface·모서리 28·여백 24·간격 16·폭 320): 2x2 · 그룹 이름 Headline · 등록 수 Label. */
@Composable
private fun MiniProfile(g: CarGroup) {
    val c = MaterialTheme.colorScheme
    Surface(Modifier.width(320.dp), GroupShape, color = c.surface) {
        Column(Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
            GroupFaces(g)
            Text(g.name, Modifier.fillMaxWidth(), style = CarText.Headline, textAlign = TextAlign.Center)
            Text(slotLine(g), Modifier.fillMaxWidth(), style = CarText.Label, color = c.onSurfaceVariant, textAlign = TextAlign.Center)
        }
    }
}

/** 그룹 얼굴: 두 사람 이상이면 2x2, 혼자면 큰 캐릭터 하나 144(C16G·C16L '주말 바다 친구들'). */
@Composable
private fun GroupAvatar(g: CarGroup) = if (g.members.size >= 2) GroupFaces(g) else Face(g.members.firstOrNull()?.character ?: "basic", 144.dp)

/**
 * 그룹 카드(C16L '그룹 / …', C16A '가족 그룹 프로필'): surface·모서리 28·여백 28·간격 24. 두 사람 이상이면 이름 Title·간격 10,
 * 혼자면 Headline·간격 8. names면 셋째 줄에 구성원 이름(C16L). onClick이 있으면 눌러 그 그룹으로.
 */
@Composable
private fun GroupCard(g: CarGroup, names: Boolean, onClick: (() -> Unit)? = null) {
    val c = MaterialTheme.colorScheme
    val many = g.members.size >= 2
    Surface(Modifier.fillMaxWidth().clip(GroupShape).then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier), GroupShape, color = c.surface) {
        Row(Modifier.padding(28.dp), horizontalArrangement = Arrangement.spacedBy(24.dp), verticalAlignment = Alignment.CenterVertically) {
            GroupAvatar(g)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(if (many) 10.dp else 8.dp)) {
                Text(g.name, style = if (many) CarText.Title.copy(letterSpacing = (-0.02).em) else CarText.Headline) // C16 2094:4816: 40 Bold −0.8px
                Text(groupLine(g), style = CarText.Label, color = c.onSurfaceVariant)
                if (names && many) Text(g.members.joinToString(", ") { it.name }, style = CarText.Label, color = c.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** 구성원과 저장된 좌석(C16A): 줄 높이 54, 자리 Label 220 · 이름 Body. 자리 없음 줄은 흐리게. */
@Composable
private fun SeatLines(members: List<GroupMember>) {
    val c = MaterialTheme.colorScheme
    Surface(Modifier.fillMaxWidth(), GroupShape, color = c.surface) {
        Column(Modifier.padding(28.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            seatLines(members).forEach { (label, names) ->
                Row(Modifier.fillMaxWidth().height(54.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(label, Modifier.width(220.dp), style = CarText.Label, color = c.onSurfaceVariant)
                    Text(names, Modifier.weight(1f), style = CarText.Body, color = if (label == "자리 없음") c.onSurfaceVariant else c.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

/**
 * 차량 좌석 배치(C13·C14·C43): surface·테두리 2 line·모서리 32·여백 28·간격 20, 칸은 운전석 accent-soft·나머지 surface-2, 여백 24·간격 12,
 * 캐릭터 118 · 이름 Headline ink · 자리 Label ink-2. 실시간 원본(11/15 C14 2005:3138·C43 2007:849)대로 고른 칸에도 테두리가 없고 이름은 ink다.
 * 자리 없는 구성원은 좌석 배정(C16B·C)에서 앉힌다.
 */
@Composable
private fun SeatGrid(members: List<GroupMember>, onPick: (SeatPick) -> Unit) {
    val c = MaterialTheme.colorScheme
    val at = members.filter { it.seat != null }.associateBy { it.seat }
    Surface(Modifier.fillMaxWidth(), CarShape.Card, color = c.surface, border = BorderStroke(2.dp, c.outlineVariant)) {
        Column(Modifier.padding(28.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Text("차량 앞쪽 ↑", style = CarText.Label, color = c.onSurfaceVariant)
            gridSeats(members).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                    row.forEach { seat ->
                        val m = at[seat.name]
                        // 빈자리도 누른다: 자리 없는 사람을 앉히거나 앉은 사람을 옮긴다.
                        Surface(Modifier.weight(1f).clip(CarShape.Card).clickable { onPick(SeatPick(m?.profileId, seat.name)) }, CarShape.Card,
                            color = if (seat == Seat.ROW_1_LEFT) c.primaryContainer else c.surfaceVariant) {
                            Column(Modifier.padding(24.dp).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                if (m != null) Face(m.character, 118.dp) else EmptySeat(118.dp)
                                Text(m?.name ?: "빈자리", style = CarText.Headline, color = c.onSurface, textAlign = TextAlign.Center)
                                Text(seatLabel(seat.name).orEmpty(), style = CarText.Label, color = c.onSurfaceVariant, textAlign = TextAlign.Center)
                            }
                        }
                    }
                }
            }
        }
    }
}

/** 좌석 배정(C16B): surface·모서리 28·여백 28·간격 20, 칸 surface-2·높이 240·간격 24, 캐릭터 88 · 자리 Label · 이름 Headline. 칸을 누르면 구성원 선택(C16C). */
@Composable
internal fun SeatAssign(members: List<GroupMember>, swaps: Boolean = true, onSeat: (String) -> Unit) {
    val c = MaterialTheme.colorScheme
    val at = members.filter { it.seat != null }.associateBy { it.seat }
    Surface(Modifier.fillMaxWidth(), GroupShape, color = c.surface) {
        Column(Modifier.padding(28.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Text("차량 앞쪽 ↑", Modifier.fillMaxWidth(), style = CarText.Label, color = c.onSurfaceVariant, textAlign = TextAlign.Center)
            gridSeats(members).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                    row.forEach { seat ->
                        val m = at[seat.name]
                        Surface(Modifier.weight(1f).height(240.dp).clip(GroupShape).clickable { onSeat(seat.name) }.semantics { contentDescription = "좌석 ${seatLabel(seat.name)}" }, GroupShape, color = c.surfaceVariant) {
                            Column(Modifier.padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically)) {
                                if (m != null) Face(m.character, 88.dp) else EmptySeat(88.dp)
                                Text(seatLabel(seat.name).orEmpty(), style = CarText.Label, color = c.onSurfaceVariant)
                                Text(m?.name ?: "빈자리", style = CarText.Headline, color = if (m != null) c.onSurface else c.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
        }
    }
    // 여행 중 자리(동승자 설정)는 서버가 한 사람씩만 옮겨 맞바꿀 수 없다 — 빈자리로만 옮긴다.
    Text(if (swaps) "이미 앉은 사람을 선택하면 두 사람의 자리가 바뀌어요." else "빈자리를 누르고 그 자리로 옮길 사람을 선택해 주세요.", Modifier.fillMaxWidth(), style = CarText.Label,
        color = c.onSurfaceVariant, textAlign = TextAlign.Center)
}

/**
 * 좌석 구성원 선택(C16C): 고른 자리 카드와 구성원 줄(surface·모서리 28·여백 28/16·캐릭터 72·이름 Headline). 서버에 '오늘 탈 사람'이 따로 없어
 * 자리로 정한다(자리 없음 = 이번 여행에 타지 않음). 자리 없는 사람을 앉은 사람의 자리에 고르면 FamilyFlow가 알림으로 이유를 알린다.
 */
@Composable
internal fun MemberPicker(members: List<GroupMember>, seat: String, onPick: (GroupMember) -> Unit) {
    val c = MaterialTheme.colorScheme
    Surface(Modifier.fillMaxWidth(), GroupShape, color = c.surface) {
        Row(Modifier.padding(28.dp), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            Text("선택한 좌석", Modifier.weight(1f), style = CarText.Label, color = c.onSurfaceVariant)
            Text(seatLabel(seat).orEmpty(), Modifier.weight(1f), style = CarText.Headline)
        }
    }
    members.forEach { m ->
        Surface(Modifier.fillMaxWidth().clip(GroupShape).clickable { onPick(m) }, GroupShape, color = c.surface) {
            Row(Modifier.padding(horizontal = 28.dp, vertical = 16.dp), horizontalArrangement = Arrangement.spacedBy(24.dp), verticalAlignment = Alignment.CenterVertically) {
                Face(m.character, 72.dp)
                Text(m.name, Modifier.weight(1f), style = CarText.Headline)
            }
        }
    }
}

/**
 * 좌석 바꾸기 제목줄(C14 '화면 제목' 2005:3150, 높이 117): 뒤로 글리프 21×32(14, 27) · 위에 '기본 그룹' Label(59, 0) ·
 * 그룹 이름 Title(59, 29) · 사람 아이콘 20과 인원(19/26, #ADC2B8). 시안이 절대 위치라 같은 자리에 둔다. 글리프는 시안에 행선이 없어 누르지 않는다(뒤로는 기기 뒤로 가기 → C43).
 */
@Composable
private fun SeatTitle(g: CarGroup?) {
    val c = MaterialTheme.colorScheme
    Box(Modifier.fillMaxWidth().height(117.dp)) {
        Box(Modifier.offset(y = 11.dp).size(59.dp, 64.dp)) {
            Image(painterResource(R.drawable.ic_group_back), null, Modifier.offset(14.dp, 16.dp).size(21.dp, 32.dp))
        }
        Text(if (g?.kind == "guest") "동승 그룹" else "기본 그룹", Modifier.offset(59.dp, 0.dp), style = CarText.Label, color = c.onSurfaceVariant)
        Row(Modifier.offset(59.dp, 29.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(g?.name ?: "우리 가족", style = CarText.Title)
            Row(Modifier.height(28.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Image(painterResource(R.drawable.ic_group_person), null, Modifier.size(20.dp))
                Text("${g?.members?.size ?: 0}", style = CountText, color = CountInk)
            }
        }
    }
}

/** 동승 그룹 상세(C16G '새 그룹 프로필'): 만든 사람 캐릭터 144, 그룹 이름 Title, '민준  |  운전석' Body. */
@Composable
private fun GuestCard(g: CarGroup) {
    val c = MaterialTheme.colorScheme
    val owner = g.members.firstOrNull { it.role == "owner" } ?: g.members.firstOrNull()
    Surface(Modifier.fillMaxWidth(), GroupShape, color = c.surface) {
        Row(Modifier.padding(28.dp), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            Face(owner?.character ?: "basic", 144.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(g.name, style = CarText.Title)
                Text("${owner?.name.orEmpty()}  |  ${seatLabel(owner?.seat) ?: "자리 없음"}", style = CarText.Body, color = c.onSurfaceVariant)
            }
        }
    }
}

/** 아이 목소리 파형(C12 '파형' 2005:3012): 높이 126, 막대 accent·모서리 3·간격 7. now까지는 실제 소리 크기, 그 뒤는 낮은 막대 10. */
@Composable
private fun Waveform(levels: DoubleArray, now: Int) {
    val c = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().height(126.dp), horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
        repeat(CHILD_WAVE_BARS) { i ->
            val h = if (i <= now) 10 + 94 * (levels.getOrNull(i) ?: 0.0) else 10.0
            Box(Modifier.weight(1f).height(h.toFloat().dp).background(c.primary, RoundedCornerShape(3.dp)))
        }
    }
}

/** 초대 화면 제목: 가족 초대(C10)는 '1명 등록 / 1명 초대 중 / 2명 미등록'과 오른쪽 2x2 배지(g에 지금 초대를 넣어 준다), 그 밖(C16·C16I)은 안내 문장. */
@Composable
private fun InviteTitle(g: CarGroup?, counted: Boolean) {
    val title = if (g?.kind == "guest") "동승자 초대하기" else "가족 초대하기"
    if (counted && g != null) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(24.dp)) {
        TitleBlock(title, slotLine(g), Modifier.weight(1f))
        GroupFaces(g, 2f / 3)
    } else TitleBlock(title, "초대 코드와 링크를 만들었어요. 편한 방식으로 전달해 주세요.")
}

/** 스캔 가능한 초대 QR(320): 흰 바탕 검은 칸(QR은 테마와 관계없이 흑백이어야 읽힌다). */
@Composable
internal fun InviteQr(url: String) {
    val matrix = remember(url) { QRCodeWriter().encode(url, BarcodeFormat.QR_CODE, 0, 0, mapOf(EncodeHintType.MARGIN to 2)) }
    Canvas(Modifier.size(320.dp).semantics { contentDescription = "초대 QR" }) {
        drawRect(Color.White)
        val unit = floor(size.minDimension / matrix.width).coerceAtLeast(1f)
        val inset = (size.minDimension - matrix.width * unit) / 2
        for (y in 0 until matrix.height) for (x in 0 until matrix.width) if (matrix[x, y]) drawRect(Color.Black, Offset(inset + x * unit, inset + y * unit), Size(unit, unit))
    }
}

/**
 * 초대 본문(C10·C16·C16I, 가족 카드 없음): 왼쪽 650 QR 카드(여백 32/24·간격 43: 초대 코드 Body · 코드 줄 56(코드 Title + 복사 아이콘 단추 56, 간격 12) · QR 320 · 안내 Body),
 * 오른쪽 남은 폭(위 여백 24·간격 20: '초대 링크' Title · 링크 카드 accent-soft 16 · '초대 링크 공유' 80 · 링크 복사/열기 80 · 안내 Body). 두 칸 간격 36.
 */
@Composable
private fun InviteBody(g: CarGroup?, invite: GroupInvite?, copy: (String) -> Unit, link: () -> String, ctx: Context, share: () -> Unit, modifier: Modifier) {
    if (invite == null) return
    val c = MaterialTheme.colorScheme
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(36.dp)) {
        Surface(Modifier.width(650.dp).fillMaxHeight(), CarShape.Card, color = c.surface) {
            Column(Modifier.padding(horizontal = 32.dp, vertical = 24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(43.dp)) {
                Text("초대 코드", style = CarText.Body)
                Row(Modifier.fillMaxWidth().height(56.dp), horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
                    Text(invite.code, style = CarText.Title)
                    Box(Modifier.size(56.dp).clip(RoundedCornerShape(10.dp)).clickable { copy(invite.code) }.semantics { contentDescription = "초대 코드 복사" }, contentAlignment = Alignment.Center) {
                        Image(painterResource(R.drawable.ic_copy), null, Modifier.size(28.dp))
                    }
                }
                InviteQr(link())
                Text("QR로도 바로 참여할 수 있어요", style = CarText.Body)
            }
        }
        Column(Modifier.weight(1f).fillMaxHeight().padding(top = 24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Text("초대 링크", style = CarText.Title)
            Surface(Modifier.fillMaxWidth(), LinkShape, color = c.primaryContainer) {
                Column(Modifier.padding(horizontal = 24.dp, vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("${g?.name ?: "우리 가족"} 초대 링크", style = CarText.Title)
                    Text("열면 앱에서 ${invite.code} 그룹으로 연결", style = CarText.Body)
                }
            }
            CarButton("초대 링크 공유", height = 80.dp, onClick = share)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                CarButton("링크 복사", Modifier.weight(1f), CarButtonKind.Secondary, height = 80.dp) { copy(link()) }
                CarButton("링크 열기", Modifier.weight(1f), CarButtonKind.Secondary, height = 80.dp) {
                    runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                }
            }
            // 시안: 가족 초대(C10·C16I)는 두 줄, 동승자 초대(C16 guestInvite)는 한 줄
            Text("코드 입력, QR 스캔, 초대 링크 모두${if (g?.kind == "guest") " " else "\n"}같은 그룹으로 참여해요.", style = CarText.Body)
        }
    }
}

/**
 * 초대 링크 공유 시트(2047:2279 FAMILY · 2047:2296 TRIP, CarSheet 800): 제목 Title · '그룹 / 코드' Body · 안내 Body · 카카오톡/메시지/링크 복사 80(간격 12) · 닫기 80.
 * 카카오톡·메시지는 그 앱으로 바로 보내고, 차에 그 앱이 없으면 링크를 복사한다('복사했어요'). 안드로이드 공유 화면 대신 시안의 시트를 쓴다.
 */
@Composable
internal fun ShareSheet(name: String, code: String, url: String, ctx: Context, copyLink: () -> Unit, close: () -> Unit) {
    val text = "$name 초대 $code\n$url"
    fun send(intent: Intent) { if (runCatching { ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isFailure) copyLink(); close() }
    CarSheet(close) {
        Text("초대 링크 공유", style = CarText.Title)
        Text("$name / $code", style = CarText.Body)
        Text("링크를 열면 이 그룹의 참여 화면으로 연결돼요.", style = CarText.Body)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            CarButton("카카오톡", Modifier.weight(1f), CarButtonKind.Secondary, height = 80.dp) {
                send(Intent(Intent.ACTION_SEND).setType("text/plain").setPackage(KAKAO).putExtra(Intent.EXTRA_TEXT, text))
            }
            CarButton("메시지", Modifier.weight(1f), CarButtonKind.Secondary, height = 80.dp) {
                send(Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:")).putExtra("sms_body", text))
            }
            CarButton("링크 복사", Modifier.weight(1f), CarButtonKind.Secondary, height = 80.dp) { copyLink(); close() }
        }
        CarButton("닫기", kind = CarButtonKind.Secondary, height = 80.dp, onClick = close)
    }
}
