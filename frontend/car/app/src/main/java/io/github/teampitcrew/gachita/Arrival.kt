package io.github.teampitcrew.gachita

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/*
 * Arrival brief of the final design v2 (flow F4, T141; Figma GISs0yf3c1KCjXwuFmF4ij): C20 waypoint arrival 2005:3369
 * ('{place} 도착', '먼저 할 일' + '잊지 말고 살 것 N개' with emoji, name, '{who} 요청', amount) and the final destination
 * finalBrief 2043:1890 ('먼저 할 일 / 잊지 말기 / 챙길 것'). Rows are the server's action items (place-rules-v2): category, items,
 * requestedBy, title. Nothing is made up here; names come only from confirmed speakers. Grouping is covered by ArrivalBriefTest.
 * The T113 flow stays: only server todos, server-approved arrival items, refresh and arrival check as small links.
 */

/** Emoji by words in the name (the design's 'Briefing / emoji' set), else by category. */
private val EMOJI = listOf(
    Regex("화장실") to "🚻",
    Regex("냉장|얼음|냉동") to "🧊", // '고기는 바로 냉장 보관' is about the fridge (finalBrief)
    Regex("고기|삼겹살|소고기|돼지|목살|한우|갈비|닭") to "🥩",
    Regex("귤|과일|사과|딸기|포도|바나나|수박|복숭아") to "🍊",
    Regex("젤리|간식|과자|사탕|초콜릿|아이스크림") to "🍬",
    Regex("음료|탄산수|^물$|생수|커피|주스|우유|맥주|콜라|사이다") to "🥤",
    Regex("가방|짐|캐리어|트렁크") to "🧳",
    Regex("장보기|장 보") to "🛒",
)
private val BY_KIND = mapOf("buy" to "🛒", "first" to "🚻", "remember" to "🧊", "bring" to "🧳")

internal fun emojiOf(name: String, category: String?): String =
    EMOJI.firstOrNull { (re, _) -> re.containsMatchIn(name) }?.second ?: BY_KIND[category] ?: "🛒"

/** '하은이 요청', '엄마 요청' (adds 이 after a final consonant). Several: '엄마·서준이 요청'. No confirmed speaker: empty. */
internal fun whoAsked(item: SharedTodo, people: List<Person>): String {
    val names = item.requestedBy.mapNotNull { id -> people.find { it.id == id }?.name }
    if (names.isEmpty()) return ""
    val last = names.last()
    return (names.dropLast(1) + (if (hasBatchim(last)) "${last}이" else last)).joinToString("·") + " 요청"
}

/** One row of the brief: emoji, name, '{who} 요청', amount (empty when none). */
internal data class BriefRow(val emoji: String, val name: String, val who: String, val qty: String, val id: String = "")

internal data class BriefRows(val first: List<BriefRow>, val buy: List<BriefRow>, val remember: List<BriefRow>, val bring: List<BriefRow>) {
    val isEmpty get() = first.isEmpty() && buy.isEmpty() && remember.isEmpty() && bring.isEmpty()
}

private fun kindOf(item: SharedTodo) = item.category?.takeIf { it in setOf("first", "buy", "remember", "bring") } ?: "remember"

/** Open asks grouped by category. A thing to buy is one row per good (with its amount); an older server's ask is one 'remember' row. */
internal fun briefRows(items: List<SharedTodo>, people: List<Person>): BriefRows {
    val g = mapOf("first" to mutableListOf<BriefRow>(), "buy" to mutableListOf(), "remember" to mutableListOf(), "bring" to mutableListOf())
    items.filter { it.pending }.forEach { item ->
        val kind = kindOf(item)
        val who = whoAsked(item, people)
        val title = item.title ?: shortAsk(item)
        if (kind == "buy" && item.items.isNotEmpty()) item.items.forEach { g.getValue("buy") += BriefRow(emojiOf(it.name, "buy"), it.name, who, it.qty.orEmpty(), item.id) }
        else g.getValue(kind) += BriefRow(emojiOf("$title ${item.items.firstOrNull()?.name.orEmpty()}", kind), title, who, "", item.id)
    }
    return BriefRows(g.getValue("first"), g.getValue("buy"), g.getValue("remember"), g.getValue("bring"))
}

/** The ask without its place phrase: '마트에서 우유 사자' → '우유 사자'. Falls back to the whole text. */
internal fun shortAsk(item: SharedTodo): String {
    val head = Regex(Regex.escape(item.place) + "에서(?:는|도)?\\s*").findAll(item.text).lastOrNull() ?: return item.text
    return item.text.substring(head.range.last + 1).trim().ifEmpty { item.text }
}

/** mock: replaces the '{who} 요청' line by the design's demo notes (task id → text). Real screens pass no details. */
internal fun BriefRows.withDetails(details: Map<String, String>): BriefRows {
    if (details.isEmpty()) return this
    fun List<BriefRow>.d() = map { it.copy(who = details[it.id] ?: it.who) }
    return BriefRows(first.d(), buy.d(), remember.d(), bring.d())
}

/** The main button: waypoint '장보고 여행 계속', final destination '여행 마치고 기록 보기'. */
internal fun arrivalButton(final: Boolean) = if (final) "여행 마치고 기록 보기" else "장보고 여행 계속"

/**
 * C20 / finalBrief. [onMain] runs the main button ('장보고 여행 계속' closes the brief, '여행 마치고 기록 보기' ends the trip and opens the
 * conversation record). [note] is the T113 sync or arrival line, shown small under the cards with refresh and arrival check.
 */
@Composable
internal fun ArrivalBrief(
    place: String, final: Boolean, items: List<SharedTodo>, people: List<Person>, note: String,
    onMain: () -> Unit, onRefresh: () -> Unit, onArrive: (() -> Unit)?, modifier: Modifier = Modifier,
    details: Map<String, String> = emptyMap(), // mock: 시안의 부가 설명 줄(할 일 id → 글). 실제 화면은 '{누구} 요청'
) {
    val c = MaterialTheme.colorScheme
    val rows = briefRows(items, people).withDetails(details)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("$place 도착", fontSize = 40.sp, lineHeight = 50.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(if (final) "내리기 전, 이 세 가지만 기억하세요" else "먼저 할 일과 살 것을 모았어요", color = c.onSurfaceVariant, fontSize = 24.sp, lineHeight = 32.sp)
        }
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val wide = maxWidth >= 1000.dp
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                if (rows.isEmpty) Text("여기서 챙길 부탁은 없어요", color = c.onSurfaceVariant, fontSize = 28.sp)
                if (rows.first.isNotEmpty()) BriefCard("먼저 할 일", rows.first, accent = true)
                if (final) {
                    if (rows.remember.isNotEmpty()) BriefCard("잊지 말기", rows.remember)
                    if (rows.bring.isNotEmpty()) BriefCard("챙길 것", rows.bring)
                    if (rows.buy.isNotEmpty()) BuyCard(rows.buy, wide)
                } else {
                    if (rows.buy.isNotEmpty()) BuyCard(rows.buy, wide)
                    if (rows.remember.isNotEmpty()) BriefCard("잊지 말기", rows.remember)
                    if (rows.bring.isNotEmpty()) BriefCard("챙길 것", rows.bring)
                }
                // 시안에는 없는 줄: 동기화·도착 확인이 어긋났을 때만 이유와 다시 해 보기 단추를 보인다
                if (note.isNotEmpty()) Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(note, Modifier.weight(1f), color = c.onSurfaceVariant, fontSize = 20.sp, lineHeight = 28.sp)
                    TextButton(onRefresh, Modifier.heightIn(min = 56.dp)) { Text("새로고침", fontSize = 20.sp) }
                    if (onArrive != null) TextButton(onArrive, Modifier.heightIn(min = 56.dp)) { Text("도착 확인", fontSize = 20.sp) }
                }
            }
        }
        BigButton(DriveButton(arrivalButton(final), Press.GO, true), onMain, Modifier.fillMaxWidth().height(96.dp))
    }
}

/** 'Briefing / action item / Car' (2056:2240): emoji, name over '{who} 요청', amount on the right. */
@Composable
private fun BriefLine(r: BriefRow, modifier: Modifier = Modifier) {
    val c = MaterialTheme.colorScheme
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(20.dp)) { // 시안 행동 줄: 이모지 44, 간격 20
        Text(r.emoji, Modifier.width(44.dp), fontSize = 34.sp, lineHeight = 44.sp, textAlign = TextAlign.Center)
        Column(Modifier.weight(1f)) {
            Text(r.name, color = c.onSurface, fontSize = 32.sp, lineHeight = 42.sp, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (r.who.isNotEmpty()) Text(r.who, color = c.onSurfaceVariant, fontSize = 24.sp, lineHeight = 32.sp, maxLines = 1)
        }
        if (r.qty.isNotEmpty()) Text(r.qty, color = c.onSurface, fontSize = 32.sp, lineHeight = 42.sp, fontWeight = FontWeight.Bold, maxLines = 1)
    }
}

/** Brief cards are 28 rounded in the design (C20 2005:3369, finalBrief 2043:1890), a little less than the other car cards (32). */
private val BRIEF_RADIUS = 28.dp

/** '먼저 할 일'(accent) / '잊지 말기' / '챙길 것' card: label, then one line per ask. */
@Composable
private fun BriefCard(label: String, rows: List<BriefRow>, accent: Boolean = false) {
    val c = MaterialTheme.colorScheme
    Surface(Modifier.fillMaxWidth(), RoundedCornerShape(BRIEF_RADIUS), color = if (accent) c.primaryContainer else c.surface) {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Text(label, color = if (accent) c.primary else c.onSurfaceVariant, fontSize = 24.sp, lineHeight = 32.sp)
            rows.forEach { BriefLine(it) }
        }
    }
}

/** '🛒 잊지 말고 살 것 N개' card. Two columns on the wide parked screen (C20 1682), one in the narrow window. */
@Composable
private fun BuyCard(rows: List<BriefRow>, wide: Boolean) {
    val c = MaterialTheme.colorScheme
    Surface(Modifier.fillMaxWidth(), RoundedCornerShape(BRIEF_RADIUS), color = c.surface) {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Text("🛒", Modifier.width(36.dp), fontSize = 28.sp, lineHeight = 36.sp, textAlign = TextAlign.Center)
                Text("잊지 말고 살 것", Modifier.weight(1f), fontSize = 32.sp, lineHeight = 42.sp, fontWeight = FontWeight.Bold)
                Text("${rows.size}개", color = c.onSurfaceVariant, fontSize = 24.sp)
            }
            // 넓은 창은 시안처럼 왼쪽 열을 먼저 채운다(삼겹살·귤 | 젤리·탄산수)
            if (wide) Row(horizontalArrangement = Arrangement.spacedBy(40.dp)) {
                rows.chunked((rows.size + 1) / 2).forEach { col ->
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(24.dp)) { col.forEach { BriefLine(it) } }
                }
                if (rows.size == 1) Column(Modifier.weight(1f)) {}
            } else rows.forEach { BriefLine(it) }
        }
    }
}

/**
 * mock: F4 화면 확인용 시연 데이터(시안 '강릉 가족 여행'). 디버그 빌드에서 `--es f4 drive|drivePaused|driveResumed|driveContinue|near|nearPaused|mart|finalNear|finalPaused|final`로만 켠다
 * (MainActivity.f4Mock). 실제 화면은 서버 할 일(GET /todos·POST /arrival-briefing)과 내비 남은 시간을 쓴다.
 */
internal object F4Mock {
    val people = listOf(Person("dad", "아빠", Seat.ROW_1_LEFT.name, true), Person("mom", "엄마", Seat.ROW_1_RIGHT.name, true),
        Person("seojun", "서준", Seat.ROW_2_LEFT.name, true), Person("haeun", "하은", Seat.ROW_2_RIGHT.name, true))
    private fun todo(id: String, place: String, category: String, title: String, items: List<TodoItem>, by: String) =
        SharedTodo(id, place, title, "pending", 0, emptyList(), category, items, listOf(by), title)
    val mart = listOf(
        todo("m1", "하나로마트", "first", "화장실 먼저 다녀오기", listOf(TodoItem("화장실", null)), "haeun"),
        todo("m2", "마트", "buy", "삼겹살 600g이랑 귤 한 봉지 사 가기", listOf(TodoItem("삼겹살", "600g"), TodoItem("귤", "1봉지")), "mom"),
        todo("m3", "마트", "buy", "젤리 한 봉지 사기", listOf(TodoItem("젤리", "1봉지")), "seojun"),
        todo("m4", "마트", "buy", "탄산수 2병 사기", listOf(TodoItem("탄산수", "2병")), "dad"),
    )
    // C19·C19p·finalPaused 화면 글('하은 화장실 / 고기와 과일 간식과 음료 챙기기', frames-text.md)을 그대로 보이려고 도착 전에는 시안의 말을 쓴다
    val martNear = listOf(mart[0],
        todo("n2", "마트", "buy", "고기랑 과일 사 가기", listOf(TodoItem("고기", null), TodoItem("과일", null)), "mom"),
        todo("n3", "마트", "bring", "간식과 음료 챙기기", listOf(TodoItem("간식", null), TodoItem("음료", null)), "").copy(requestedBy = emptyList()))
    // 녹음 화면의 도착 전(A D20·D20p '화장실 가기 / 장보기 / 쓰레기 정리하기') 시안 부탁
    val martBrief = martNear.take(2) + todo("n4", "마트", "remember", "쓰레기 정리하기", listOf(TodoItem("쓰레기", null)), "dad")
    // 녹음 화면(A D17·D19) 시연 파형: 시안 wave/live(2107:5463) 막대 높이 ÷ 140
    val wave = listOf(8, 47, 23, 23, 12, 24, 71, 11, 105, 44, 60, 25, 20, 75, 15, 123, 47, 77, 41, 11, 35, 14, 70, 27, 48, 29, 15, 10, 10, 31,
        16, 36, 28, 22, 17, 10, 45, 24, 79, 63, 54, 51, 9, 48, 26, 108, 81, 77, 77, 17, 16, 16, 72, 53, 55, 54, 17, 17, 9, 28).map { it / 140f }
    val lodge = listOf(
        todo("l1", "숙소", "first", "화장실 먼저 다녀오기", listOf(TodoItem("화장실", null)), "haeun"),
        todo("l2", "숙소", "remember", "고기는 바로 냉장 보관", listOf(TodoItem("냉장 보관", null)), "mom"),
        todo("l3", "숙소", "bring", "체크인하고 가방 내리기", listOf(TodoItem("체크인", null), TodoItem("가방", null)), "dad"),
    )
    // finalBrief의 부가 설명 줄(frames-text.md). 규칙으로 만들 수 없는 시연 글이라 목업에서만 쓴다
    val lodgeDetails = mapOf("l1" to "하은이와 함께 1층 화장실", "l2" to "엄마가 부탁한 장본 짐 정리", "l3" to "예약자 민준 / 트렁크의 가족 가방")
    // 주행 시연(T150, --es f4 drive|drivePaused|driveResumed|driveContinue)의 받아 적은 말 두 줄(시안 17–19·22, 새것이 위)과 말하는 사람
    fun heard(state: String): List<HeardRow> =
        (if (state == "driveContinue") listOf(people[3] to "우리 내일도 같이 타면 안 돼?", people[1] to "숙소에 가서 맛있게 먹자")
        else listOf(people[2] to "아빠, 바다는 왜 짜?", people[1] to "마트에서 고기랑 과일도 사 가자"))
            .map { (p, text) -> HeardRow(heardMeta(p.name, p.seat, null), text, seatCharacter(p)) }
    fun talking(state: String): String? = when { state.endsWith("Paused") -> null; state == "driveContinue" -> "haeun"; else -> "seojun" }
}
