package io.github.teampitcrew.gachita

import java.math.BigDecimal
import java.security.MessageDigest

// 할 일 행동 항목(place-rules-v2, T141)을 차 안에서 도출한다(T144). backend/api/todos.js의 todoOf·actionOf·deriveTodos와
// 같은 규칙·같은 순서이고, 두 구현은 backend/api/todo-vectors.json 한 파일로 맞춘다(TodoActionsTest.kt). 한쪽만 고치면 시험이 걸린다.
// id는 서버와 같은 sha256(JSON [장소, 글]) 앞 32자라 서버에 남은 완료·취소 상태가 그대로 붙는다.

/** 받아 적은 발화 한 줄. text는 화면에 보이는 글(교정본 우선). participantId는 확인된 화자. */
data class TodoLine(val device: String, val seq: Long, val at: Long, val text: String, val participantId: String? = null)
data class TodoGood(val name: String, val qty: String?)
data class TodoAction(
    val id: String, val place: String, val text: String, val category: String, val title: String,
    val items: List<TodoGood>, val requestedBy: List<String>, val sources: List<TodoLine>,
) {
    val method get() = TODO_ACTION_METHOD
}

const val TODO_ACTION_METHOD = "place-rules-v2"
private val V2_AT = Regex("([가-힣A-Za-z0-9]{1,10})에서(?:는|도)?\\s*")
private val V2_GO = Regex("(?:^|\\s)([가-힣A-Za-z0-9]{1,10}?)(?:에)?\\s+(?:가면|가서|도착하면)\\s+")
private val V2_END = Regex("(자|야지|야 ?[돼되해]요?|급해요?)$")
private val V2_NOT_VERB = setOf("피자", "과자", "의자", "모자", "상자", "여자", "남자", "부자")
private val FIRST = Regex("화장실|먼저|급해")
private val BUY = Regex("(?:^|\\s)사(?:\\s?(?:가|오|와|다|두|둬|놓))?\\s?(?:자|야지|야 ?[돼되해]요?)$")
private val BRING = Regex("(?:^|\\s)(?:챙기|챙겨|가져가|가져와|가지고\\s?가|가지고\\s?와|내리|내려|꺼내)")
private val FILLER = setOf("먼저", "바로", "꼭", "좀", "빨리", "일단", "같이", "우리", "다", "또", "잊지", "말고", "까먹지", "제발")
private val NATIVE = linkedMapOf("한" to 1, "두" to 2, "세" to 3, "네" to 4, "다섯" to 5, "여섯" to 6, "일곱" to 7, "여덟" to 8, "아홉" to 9, "열" to 10)
private val UNIT = linkedMapOf("kg" to "kg", "킬로그램" to "kg", "킬로" to "kg", "g" to "g", "그램" to "g", "개" to "개", "병" to "병", "봉지" to "봉지", "팩" to "팩", "캔" to "캔", "마리" to "마리")
private val QTY = Regex("(?:^|\\s)(\\d+(?:\\.\\d+)?|${NATIVE.keys.joinToString("|")})\\s?(${UNIT.keys.joinToString("|")})(?=$|\\s|[은는을를도씩])")
private val SPACES = Regex("\\s+")
private val STEM = mapOf("가" to "가기", "와" to "오기", "사" to "사기", "해" to "하기", "봐" to "보기", "챙겨" to "챙기기", "챙기" to "챙기기", "내려" to "내리기", "내리" to "내리기", "꺼내" to "꺼내기", "가져가" to "가져가기", "가져와" to "가져오기")

/** 장소와 그 뒤의 글. '에서'가 있으면 그것만 본다(v1이 뽑던 문장은 장소가 바뀌지 않게). */
private fun placeOf(text: String): Pair<String, String>? {
    val m = V2_AT.findAll(text).lastOrNull() ?: V2_GO.findAll(text).lastOrNull() ?: return null
    return m.groupValues[1] to text.substring(m.range.last + 1)
}

private fun todoV2Of(value: String): Pair<String, String>? {
    val text = value.trim().replace(Regex("[.!? ]+$"), "")
    val found = placeOf(text) ?: return null
    if (!V2_END.containsMatchIn(text) || text.substringAfterLast(' ') in V2_NOT_VERB) return null
    return found.first to text
}

private fun hangul(c: Char?) = c != null && c in '가'..'힣'
private fun batchim(c: Char?) = hangul(c) && (c!!.code - 0xAC00) % 28 != 0

/** 낱말 끝의 이음 조사(랑·이랑·하고·와·과)를 뗀 낱말, 이음 조사가 아니면 null. 받침으로 가린다('사과', '노랑'은 그대로). */
private fun joined(w: String): String? {
    fun prev(n: Int) = w.getOrNull(w.length - n - 1)
    return when {
        w.endsWith("하고") && w.length > 2 -> w.dropLast(2)
        w.endsWith("이랑") && w.length > 2 && (batchim(prev(2)) || !hangul(prev(2))) -> w.dropLast(2)
        w.endsWith("랑") && w.length >= 3 && !batchim(prev(1)) -> w.dropLast(1)
        w.endsWith("와") && w.length >= 3 && hangul(prev(1)) && !batchim(prev(1)) -> w.dropLast(1)
        w.endsWith("과") && w.length >= 2 && (batchim(prev(1)) || !hangul(prev(1))) -> w.dropLast(1)
        else -> null
    }
}

private fun bare(w: String) = when {
    w.length >= 3 && (w.endsWith("부터") || w.endsWith("까지")) -> w.dropLast(2)
    w.length >= 2 && w.last() in "은는을를" -> w.dropLast(1)
    w.length >= 3 && w.endsWith("도") -> w.dropLast(1)
    else -> w
}
private fun clean(words: List<String>) = words.filter { it !in FILLER }.map(::bare).filter { it.isNotEmpty() }.joinToString(" ")
private fun words(s: String) = s.split(SPACES).filter { it.isNotEmpty() }

private fun goodOf(phrase: String): TodoGood? {
    val m = QTY.find(phrase)
    // JS Number()처럼: "600" → 600, "1.50" → 1.5
    val qty = m?.let { (NATIVE[it.groupValues[1]]?.toString() ?: BigDecimal(it.groupValues[1]).stripTrailingZeros().toPlainString()) + UNIT[it.groupValues[2]] }
    val name = clean(words(if (m != null) phrase.substring(0, m.range.first) + " " + phrase.substring(m.range.last + 1) else phrase))
    return if (name.isNotEmpty()) TodoGood(name, qty) else null
}

private fun goodsOf(phrase: String): List<TodoGood> {
    val parts = ArrayList<String>()
    for (piece in phrase.split(Regex(",|\\s그리고\\s"))) {
        var cur = ArrayList<String>()
        val ws = words(piece.trim())
        ws.forEachIndexed { i, w ->
            val cut = if (i < ws.size - 1) joined(w) else null
            cur += cut ?: w
            if (cut != null) { parts += cur.joinToString(" "); cur = ArrayList() }
        }
        if (cur.isNotEmpty()) parts += cur.joinToString(" ")
    }
    return parts.mapNotNull(::goodOf)
}

private fun wordsOf(rest: String) = words(rest.replaceFirst(V2_END, "").trim()).toMutableList()

private fun titleOf(rest: String): String {
    val ws = wordsOf(rest)
    val last = ws.lastOrNull() ?: return ""
    when {
        last == "가" && "화장실" in ws -> ws[ws.size - 1] = "다녀오기"
        STEM[last] != null -> ws[ws.size - 1] = STEM.getValue(last)
        last.length >= 3 && last.endsWith("해") -> ws[ws.size - 1] = last.dropLast(1)
        last.length == 1 -> ws[ws.size - 1] = "${last}기"
    }
    return ws.joinToString(" ")
}

private fun subjectOf(rest: String): List<TodoGood> {
    val ws = wordsOf(rest)
    val last = ws.lastOrNull()
    if (last != null && (STEM[last] != null || last.length == 1)) ws.removeAt(ws.size - 1)
    else if (last != null && last.length >= 3 && last.endsWith("해")) ws[ws.size - 1] = last.dropLast(1)
    val name = clean(ws)
    return if (name.isNotEmpty()) listOf(TodoGood(name, null)) else emptyList()
}

/** JSON.stringify([place, text])와 같은 바이트. */
private fun todoId(place: String, text: String): String {
    fun q(s: String) = buildString {
        append('"')
        for (c in s) when {
            c == '"' -> append("\\\"")
            c == '\\' -> append("\\\\")
            c == '\n' -> append("\\n")
            c == '\r' -> append("\\r")
            c == '\t' -> append("\\t")
            c == '\b' -> append("\\b")
            c == '\u000c' -> append("\\f")
            c < ' ' -> append("\\u%04x".format(c.code))
            else -> append(c)
        }
        append('"')
    }
    val hash = MessageDigest.getInstance("SHA-256").digest("[${q(place)},${q(text)}]".toByteArray())
    return hash.joinToString("") { "%02x".format(it) }.take(32)
}

/** 발화(시각 순, 살아 있는 것만)에서 장소별 할 일과 행동 항목. 같은 장소·같은 말은 한 건으로 묶고 출처를 모은다. */
fun deriveActionTodos(lines: List<TodoLine>): List<TodoAction> {
    val found = LinkedHashMap<String, Triple<String, String, MutableList<TodoLine>>>()
    for (line in lines) {
        if (line.text.isEmpty()) continue
        val (place, text) = todoV2Of(line.text) ?: continue
        found.getOrPut(todoId(place, text)) { Triple(place, text, ArrayList()) }.third += line
    }
    return found.map { (id, t) ->
        val (place, text, sources) = t
        val rest = placeOf(text)?.second ?: text
        val buy = BUY.find(rest)
        val bring = BRING.findAll(rest).lastOrNull()?.takeIf { it.range.first > 0 }
        val category = if (FIRST.containsMatchIn(text)) "first" else if (buy != null) "buy" else if (bring != null) "bring" else "remember"
        val obj = buy?.let { rest.substring(0, it.range.first) } ?: bring?.let { rest.substring(0, it.range.first) }
        TodoAction(id, place, text, category, titleOf(rest), if (obj != null) goodsOf(obj) else subjectOf(rest),
            sources.mapNotNull { it.participantId }.distinct(), sources)
    }
}
