package io.github.teampitcrew.gachita

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

// 도착 브리핑(T40)에서 화면·SDK와 무관한 것(단위 테스트 TodosTest.kt). 흐름은 MainActivity, 내비 조회는 Car.kt.

/** 장소가 붙은 할 일 한 건. text는 받아 적은 말 그대로이고 place는 그 말에서 뽑은 장소 낱말. */
data class Todo(val id: Long, val place: String, val text: String, val done: Boolean = false)

private val TODO_AT = Regex("([가-힣A-Za-z0-9]{1,10})에서(?:는|도)?\\s*(.+)")
private val TODO_END = Regex("(자|야지|야 ?[돼되해])$") // STT는 "사야 돼"를 "사야 되"로 적기도 했다(11/13)

/**
 * "마트에서 우유랑 간식 사자" → ("마트", 원문). 장소 + '에서' + 할 일이고 권하거나 해야 한다는 말로 끝날 때만.
 * ponytail: 낱말 규칙. 장소가 '에서' 없이 오거나("마트 들러서 …") 말이 길면 놓친다. LLM 판정은 음성 처리 흐름(T12) 뒤에.
 */
fun todoOf(text: String): Pair<String, String>? {
    val t = text.trim().trimEnd('.', '!', '?', ' ')
    val m = TODO_AT.find(t) ?: return null
    if (!TODO_END.containsMatchIn(t)) return null
    return m.groupValues[1] to t
}

/** 내비의 목적지·경유지 이름에 장소 낱말이 있으면 그곳이다("마트" ⊂ "이마트 강릉점"). 띄어쓰기는 보지 않는다. */
fun arrivedAt(place: String, naviNames: List<String>) = naviNames.any { place in it.replace(" ", "") }

/**
 * 여행 하나의 할 일. 앱 저장소의 todos-<여행 코드>.json에 통째로 다시 쓴다(몇십 건이라 충분). 메인 스레드에서만 만진다.
 * ponytail: 차 안에만 둔다. 서버 API에는 장소가 붙은 할 일이 없다(부탁에 장소 칸 없음). 서버 저장은 T39 쪽에서 정하면 옮긴다.
 */
class Todos(dir: File, val trip: String) {
    private val file = File(dir, "todos-$trip.json")
    var items: List<Todo> = runCatching {
        JSONArray(file.readText()).let { a ->
            List(a.length()) { i -> a.getJSONObject(i).let { Todo(it.getLong("id"), it.getString("place"), it.getString("text"), it.getBoolean("done")) } }
        }
    }.getOrDefault(emptyList())
        private set

    fun open(place: String? = null) = items.filter { !it.done && (place == null || it.place == place) }

    fun add(place: String, text: String): Todo = Todo((items.maxOfOrNull { it.id } ?: 0) + 1, place, text).also { save(items + it) }

    fun done(id: Long) = save(items.map { if (it.id == id) it.copy(done = true) else it })

    private fun save(next: List<Todo>) {
        items = next
        file.writeText(JSONArray(next.map { JSONObject().put("id", it.id).put("place", it.place).put("text", it.text).put("done", it.done) }).toString())
    }
}

/** TTS로 읽을 도착 알림. 할 일은 받아 적은 말 그대로 읽는다. */
fun briefingLine(place: String?, open: List<Todo>): String =
    (if (place != null) "${place}에 도착했어요. " else "") + "할 일 ${open.size}건. " + open.joinToString(". ") { it.text }
