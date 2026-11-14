package io.github.teampitcrew.gachita

import androidx.annotation.DrawableRes
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/*
 * Arrival brief (flow F4, T141 → T156; Figma Y7zFqGUEAFDWTumG30MsOs page 2004:57, read live). Three frames, each drawn as it is:
 * C20 2005:3369 (wide waypoint: picture in front, goods with pictures in two columns), D19 2032:6496 = its revision 2131:6137 (narrow
 * waypoint: picture at the right end, goods as name and amount), finalBrief 2043:1890 (final destination: picture in front,
 * '먼저 할 일 / 잊지 말기 / 챙길 것', cards 24/20). Every arrival ends with the design's fixed '쓰레기 정리하기' card. Rows are the server's
 * action items (place-rules-v2): category, items, requestedBy, title. Names come only from confirmed speakers (ArrivalBriefTest).
 */

/**
 * The design's 'Briefing / emoji' pictures (Twemoji 14.0.2, CC-BY 4.0, exported from the Figma components into res/drawable/ic_brief_*),
 * drawn as images instead of emoji characters.
 */
internal enum class BriefIcon(@DrawableRes val res: Int) {
    RESTROOM(R.drawable.ic_brief_restroom), // 1f6bb 2057:2408
    COLD(R.drawable.ic_brief_ice), // 1f9ca 2057:2420
    MEAT(R.drawable.ic_brief_meat), // 1f969 2057:2370
    FRUIT(R.drawable.ic_brief_tangerine), // 1f34a 2057:2379
    SNACK(R.drawable.ic_brief_candy), // 1f36c 2057:2384
    DRINK(R.drawable.ic_brief_drink), // 1f964 2057:2392
    LUGGAGE(R.drawable.ic_brief_luggage), // 1f9f3 2057:2430
    CART(R.drawable.ic_brief_cart), // 1f6d2 2057:2412
    TRASH(R.drawable.ic_brief_trash), // '쓰레기 정리' 2063:2666
}

/** Picture by words in the name, else by category. */
private val ICON_BY_NAME = listOf(
    Regex("화장실") to BriefIcon.RESTROOM,
    Regex("냉장|얼음|냉동") to BriefIcon.COLD, // '고기는 바로 냉장 보관' is about the fridge (finalBrief)
    Regex("고기|삼겹살|소고기|돼지|목살|한우|갈비|닭") to BriefIcon.MEAT,
    Regex("귤|과일|사과|딸기|포도|바나나|수박|복숭아") to BriefIcon.FRUIT,
    Regex("젤리|간식|과자|사탕|초콜릿|아이스크림") to BriefIcon.SNACK,
    Regex("음료|탄산수|^물$|생수|커피|주스|우유|맥주|콜라|사이다") to BriefIcon.DRINK,
    Regex("가방|짐|캐리어|트렁크") to BriefIcon.LUGGAGE,
    Regex("쓰레기|분리배출|분리수거") to BriefIcon.TRASH,
    Regex("장보기|장 보") to BriefIcon.CART,
)
private val ICON_BY_KIND = mapOf("buy" to BriefIcon.CART, "first" to BriefIcon.RESTROOM, "remember" to BriefIcon.COLD, "bring" to BriefIcon.LUGGAGE)

internal fun iconOf(name: String, category: String?): BriefIcon =
    ICON_BY_NAME.firstOrNull { (re, _) -> re.containsMatchIn(name) }?.second ?: ICON_BY_KIND[category] ?: BriefIcon.CART

/** '하은이 요청', '엄마 요청' (adds 이 after a final consonant). Several: '엄마·서준이 요청'. No confirmed speaker: empty. */
internal fun whoAsked(item: SharedTodo, people: List<Person>): String {
    val names = item.requestedBy.mapNotNull { id -> people.find { it.id == id }?.name }
    if (names.isEmpty()) return ""
    val last = names.last()
    return (names.dropLast(1) + (if (hasBatchim(last)) "${last}이" else last)).joinToString("·") + " 요청"
}

/** One row of the brief: picture, name, '{who} 요청', amount (empty when none). */
internal data class BriefRow(val icon: BriefIcon, val name: String, val who: String, val qty: String, val id: String = "")

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
        if (kind == "buy" && item.items.isNotEmpty()) item.items.forEach { g.getValue("buy") += BriefRow(iconOf(it.name, "buy"), it.name, who, it.qty.orEmpty(), item.id) }
        else g.getValue(kind) += BriefRow(iconOf("$title ${item.items.firstOrNull()?.name.orEmpty()}", kind), title, who, "", item.id)
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

/** The main button: waypoint '계속' (C20·D19), final destination '여행 마치고 기록 보기' (finalBrief). */
internal fun arrivalButton(final: Boolean) = if (final) "여행 마치고 기록 보기" else "계속"

/** The subtitle: waypoint (C20·D19) and final destination (finalBrief 2043:1890). */
internal fun arrivalSub(final: Boolean) = if (final) "내리기 전, 할 일과 챙길 것" else "먼저 할 일과 살 것을 모았어요"

/**
 * Where each frame puts things. [pictureFirst]: the picture 44 before the text (C20, finalBrief) or at the right end (D19).
 * [pad]: card padding. D19's goods are name and amount only, C20's have their picture in front.
 */
private enum class BriefLayout(val pictureFirst: Boolean, val pad: PaddingValues) {
    WIDE(true, PaddingValues(24.dp)), // C20 2005:3369 (1682 parked screen)
    NARROW(false, PaddingValues(24.dp)), // D19 2032:6496 = D19 수정본 2131:6137 (841 window)
    FINAL(true, PaddingValues(horizontal = 24.dp, vertical = 20.dp)), // finalBrief 2043:1890
}

/**
 * C20 / D19 / finalBrief. [onMain] runs the main button ('계속' closes the brief, '여행 마치고 기록 보기' ends the trip and opens the
 * conversation record). [note], [onRefresh] and [onArrive] are no longer drawn (the design has no sync line); they stay until the call
 * site in MainActivity (F3) drops them.
 */
@Suppress("UNUSED_PARAMETER")
@Composable
internal fun ArrivalBrief(
    place: String, final: Boolean, items: List<SharedTodo>, people: List<Person>, note: String,
    onMain: () -> Unit, onRefresh: () -> Unit, onArrive: (() -> Unit)?, modifier: Modifier = Modifier,
    details: Map<String, String> = emptyMap(), // mock: 시안의 부가 설명 줄(할 일 id → 글). 실제 화면은 '{누구} 요청'
) {
    val rows = briefRows(items, people).withDetails(details)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(24.dp)) {
        TitleBlock("$place 도착", arrivalSub(final))
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val wide = maxWidth >= 1000.dp
            val l = when { final -> BriefLayout.FINAL; wide -> BriefLayout.WIDE; else -> BriefLayout.NARROW }
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                if (rows.first.isNotEmpty()) BriefCard("먼저 할 일", rows.first, l, accent = true)
                if (final) {
                    if (rows.remember.isNotEmpty()) BriefCard("잊지 말기", rows.remember, l)
                    if (rows.bring.isNotEmpty()) BriefCard("챙길 것", rows.bring, l)
                    if (rows.buy.isNotEmpty()) BuyCard(rows.buy, l, wide)
                } else {
                    if (rows.buy.isNotEmpty()) BuyCard(rows.buy, l, wide)
                    if (rows.remember.isNotEmpty()) BriefCard("잊지 말기", rows.remember, l)
                    if (rows.bring.isNotEmpty()) BriefCard("챙길 것", rows.bring, l)
                }
                BriefCard(null, listOf(TIDY_UP), l, pad = PaddingValues(horizontal = 24.dp, vertical = 20.dp))
            }
        }
        CarButton(arrivalButton(final), onClick = onMain)
    }
}

/** The fixed last card of every arrival (시안 '쓰레기 정리 / 내리기 전' 2063:3119·2131:6166·2063:3173): not a family ask, so no requester. */
private val TIDY_UP = BriefRow(BriefIcon.TRASH, "쓰레기 정리하기", "빈 병과 과자 봉지 챙겨 분리배출", "")

/** Brief cards are 28 rounded in the design, a little less than the other car cards (CarShape.Card 32). */
private val BriefShape = RoundedCornerShape(28.dp)

/**
 * Figma text boxes keep the whole line height (Headline 42, Label 32). Compose trims the space above the first line and below the last,
 * which makes every line 3–4 lower than the design; these keep it. (Belongs in CarText — reported to F3.)
 */
private val FullLine = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None)
private val BriefHeadline = CarText.Headline.copy(lineHeightStyle = FullLine)
private val BriefLabel = CarText.Label.copy(lineHeightStyle = FullLine)

@Composable
private fun Picture(icon: BriefIcon, size: Int = 44, modifier: Modifier = Modifier) = Image(painterResource(icon.res), null, modifier.size(size.dp))

/**
 * One action row ('Briefing / action item / Car' 2056:2240): picture 44, gap 20, name (Headline) over '{who} 요청' (Label, gap 4),
 * amount at the right end. The picture is in front (C20, finalBrief) or at the right end (D19).
 */
@Composable
private fun BriefLine(r: BriefRow, pictureFirst: Boolean, showWho: Boolean = true) {
    val c = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(20.dp)) {
        if (pictureFirst) Picture(r.icon)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(r.name, style = BriefHeadline, color = c.onSurface, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (showWho && r.who.isNotEmpty()) Text(r.who, style = BriefLabel, color = c.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (r.qty.isNotEmpty()) Text(r.qty, style = BriefHeadline, color = c.onSurface, maxLines = 1)
        if (!pictureFirst) Picture(r.icon)
    }
}

/** '먼저 할 일'(accent-soft, label accent) / '잊지 말기' / '챙길 것' card: label (Label 24), gap 18, one line per ask. No label: the tidy-up card. */
@Composable
private fun BriefCard(label: String?, rows: List<BriefRow>, l: BriefLayout, accent: Boolean = false, pad: PaddingValues = l.pad) {
    val c = MaterialTheme.colorScheme
    Surface(Modifier.fillMaxWidth(), BriefShape, color = if (accent) c.primaryContainer else c.surface) {
        Column(Modifier.padding(pad), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            if (label != null) Text(label, style = BriefLabel, color = if (accent) c.primary else c.onSurfaceVariant)
            rows.forEach { BriefLine(it, l.pictureFirst) }
        }
    }
}

/**
 * '잊지 말고 살 것' card, gap 18. D19 (2131:6156): title, 'N개' at 203, cart 36 at the right end (12 in); goods are name and amount, 14
 * apart. C20 (2056:2260): cart 36 · title · 'N개' at the right end (gap 16); goods have their picture in front, 24 apart, in two
 * columns 40 apart on the wide screen (the left column fills first: 삼겹살·귤 | 젤리·탄산수).
 */
@Composable
private fun BuyCard(rows: List<BriefRow>, l: BriefLayout, wide: Boolean) {
    val c = MaterialTheme.colorScheme
    Surface(Modifier.fillMaxWidth(), BriefShape, color = c.surface) {
        Column(Modifier.padding(l.pad), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            if (l.pictureFirst) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    Picture(BriefIcon.CART, 36)
                    Text("잊지 말고 살 것", Modifier.weight(1f), style = BriefHeadline, color = c.onSurface)
                    Text("${rows.size}개", style = BriefLabel, color = c.onSurfaceVariant)
                }
                val cols = if (wide) rows.chunked((rows.size + 1) / 2) else listOf(rows)
                Row(horizontalArrangement = Arrangement.spacedBy(40.dp)) {
                    cols.forEach { col ->
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(24.dp)) { col.forEach { BriefLine(it, true, showWho = false) } }
                    }
                    if (wide && rows.size == 1) Spacer(Modifier.weight(1f))
                }
            } else {
                Box(Modifier.fillMaxWidth().height(42.dp)) {
                    Text("잊지 말고 살 것", style = BriefHeadline, color = c.onSurface)
                    Text("${rows.size}개", Modifier.offset(203.dp, 5.dp), style = BriefLabel, color = c.onSurfaceVariant)
                    Picture(BriefIcon.CART, 36, Modifier.align(Alignment.TopEnd).padding(end = 12.dp))
                }
                Column(verticalArrangement = Arrangement.spacedBy(14.dp)) { rows.forEach { BuyLine(it) } }
            }
        }
    }
}

/** A good in D19 (instance of 'Briefing / action item / Car' with picture and requester hidden): name, amount at the right end. */
@Composable
private fun BuyLine(r: BriefRow) {
    val c = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(20.dp)) {
        Text(r.name, Modifier.weight(1f), style = BriefHeadline, color = c.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (r.qty.isNotEmpty()) Text(r.qty, style = BriefHeadline, color = c.onSurface, maxLines = 1)
    }
}

/**
 * mock: F4 화면 확인용 시연 데이터(시안 '강릉 가족 여행'). 디버그 빌드에서 `--es f4 near|nearPaused|mart|finalNear|finalPaused|final`로만 켠다
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
