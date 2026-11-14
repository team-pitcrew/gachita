package io.github.teampitcrew.gachita

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

// 도착 브리핑(T40)에서 화면·SDK와 무관한 것(단위 테스트 TodosTest.kt). 흐름은 MainActivity, 내비 조회는 Car.kt.

/** 장소가 붙은 할 일 한 건. text는 받아 적은 말 그대로이고 place는 그 말에서 뽑은 장소 낱말. */
data class Todo(val id: Long, val place: String, val text: String, val done: Boolean = false)

private val TODO_AT = Regex("([가-힣A-Za-z0-9]{1,10})에서(?:는|도)?\\s*")
private val TODO_END = Regex("(자|야지|야 ?[돼되해])$") // STT는 "사야 돼"를 "사야 되"로 적기도 했다(11/13)
private val NOT_VERB = setOf("피자", "과자", "의자", "모자", "상자", "여자", "남자", "부자") // '자'로 끝나지만 권하는 말이 아닌 낱말

/**
 * "마트에서 우유랑 간식 사자" → ("마트", 원문). 장소 + '에서' + 할 일이고 권하거나 해야 한다는 말로 끝날 때만.
 * 장소는 마지막 '에서' 앞의 낱말이다("집에서 나오기 전에 마트에서 사자" → 마트).
 * ponytail: 낱말 규칙. 장소가 '에서' 없이 오거나("마트 들러서 …") 말이 길면 놓친다. LLM 판정은 음성 처리 흐름(T12) 뒤에.
 */
fun todoOf(text: String): Pair<String, String>? {
    val t = text.trim().trimEnd('.', '!', '?', ' ')
    val m = TODO_AT.findAll(t).lastOrNull() ?: return null
    if (!TODO_END.containsMatchIn(t) || t.substringAfterLast(' ') in NOT_VERB) return null
    return m.groupValues[1] to t
}

/** 내비가 향하는 다음 곳 이름에 장소 낱말이 있으면 그곳이다("마트" ⊂ "이마트 강릉점"). 띄어쓰기는 보지 않는다. */
fun arrivedAt(place: String, nextStop: String?) = nextStop != null && place in nextStop.replace(" ", "")

/**
 * 여행 하나의 할 일. 앱 저장소의 todos-<여행 코드>.json에 통째로 암호화해 다시 쓴다(몇십 건이라 충분, Vault.kt). 메인 스레드에서만 만진다.
 * 보관 기간으로 자동 만료하지 않으며, 해당 여행을 명시적으로 삭제할 때 함께 정리한다.
 * 이전 판 파일 호환용 클래스입니다. T113 화면은 이 파일을 읽거나 합치지 않고 서버 T103 API만 정본으로 사용합니다.
 */
class Todos(dir: File, val trip: String, private val seal: Seal) {
    private val file = File(dir, "todos-$trip.json")
    var items: List<Todo> = runCatching {
        JSONArray(seal.unline(file.readText())).let { a ->
            List(a.length()) { i -> a.getJSONObject(i).let { Todo(it.getLong("id"), it.getString("place"), it.getString("text"), it.getBoolean("done")) } }
        }
    }.getOrDefault(emptyList())
        private set

    fun open(place: String? = null) = items.filter { !it.done && (place == null || it.place == place) }

    /**
     * 같은 장소에 같은 말이 이미 있으면(완료한 것 포함) 더하지 않고 null. 도착 알림을 읽는 우리 TTS가 마이크로 되돌아와
     * 같은 할 일이 다시 모이거나 완료한 것이 되살아나지 않게.
     */
    fun add(place: String, text: String): Todo? {
        if (items.any { it.place == place && it.text == text }) return null
        return Todo((items.maxOfOrNull { it.id } ?: 0) + 1, place, text).also { save(items + it) }
    }

    fun done(id: Long) = save(items.map { if (it.id == id) it.copy(done = true) else it })

    /** 임시 파일에 다 쓴 뒤 이름을 바꾼다. 쓰다 끊기거나 바꾸지 못하면 앞의 파일이 남고, 이번 실행의 목록은 그대로 쓴다. */
    private fun save(next: List<Todo>) {
        items = next
        val tmp = File(file.path + ".tmp")
        runCatching {
            tmp.writeText(seal.line(JSONArray(next.map { JSONObject().put("id", it.id).put("place", it.place).put("text", it.text).put("done", it.done) }).toString()))
            tmp.renameTo(file)
        }
    }
}

/** TTS로 읽을 도착 알림. 할 일은 받아 적은 말 그대로 읽는다. */
fun briefingLine(place: String?, open: List<Todo>): String =
    (if (place != null) "${place}에 도착했어요. " else "") + "할 일 ${open.size}건. " + open.joinToString(". ") { it.text }

// T113: 서버 응답만 현재 화면의 정본입니다. 위의 이전 판 파일과 추출 함수는 호환을 위해 남기며 새 목록에 합치지 않습니다.
data class SharedTodoSource(val device: String, val seq: Long, val at: Long, val text: String, val displayText: String, val participantId: String?)
/** One thing inside an ask ('삼겹살 600g이랑 귤 한 봉지' → 삼겹살·600g, 귤·1봉지). qty is null when the words gave no amount. */
data class TodoItem(val name: String, val qty: String?)

/**
 * category, items, requestedBy come from the v2 rules (A5, `place-rules-v2`): first·buy·remember·bring, the things asked for,
 * and confirmed requesters. An older server (`place-rules-v1`) leaves them null/empty and the brief shows the ask as one row.
 */
data class SharedTodo(
    val id: String, val place: String, val text: String, val status: String, val version: Int, val sources: List<SharedTodoSource>,
    val category: String? = null, val items: List<TodoItem> = emptyList(), val requestedBy: List<String> = emptyList(), val title: String? = null,
) {
    val pending get() = status == "pending"
}
data class SharedTodos(val generation: Int, val method: String, val items: List<SharedTodo>)
data class TodoScope(val server: String, val trip: String, val generation: Int, val token: String)
data class TodoAttempt(val scope: TodoScope, val sequence: Long)

fun sharedTodo(o: JSONObject): SharedTodo {
    val status = o.getString("status"); require(status in setOf("pending", "done", "cancelled"))
    val version = o.getInt("version"); require(version >= 0)
    val sources = o.getJSONArray("sources")
    val items = o.optJSONArray("items")
    val by = o.optJSONArray("requestedBy")
    return SharedTodo(o.getString("id"), o.getString("place"), o.getString("text"), status, version,
        List(sources.length()) { i -> sources.getJSONObject(i).let { s ->
            SharedTodoSource(s.getString("device"), s.getLong("seq"), s.getLong("at"), s.getString("text"), s.getString("displayText"),
                if (s.isNull("participantId")) null else s.getString("participantId"))
        } },
        category = o.optString("category").takeIf { !o.isNull("category") && it.isNotBlank() },
        items = (0 until (items?.length() ?: 0)).mapNotNull { i -> items!!.getJSONObject(i).let { it.optString("name").trim().takeIf(String::isNotEmpty)?.let { n -> TodoItem(n, it.optString("qty").takeIf { q -> !it.isNull("qty") && q.isNotBlank() }) } } },
        requestedBy = (0 until (by?.length() ?: 0)).map { by!!.getString(it) }.distinct(),
        title = o.optString("title").takeIf { !o.isNull("title") && it.isNotBlank() },
    )
}
fun sharedTodos(json: String): SharedTodos = JSONObject(json).let { o ->
    val a = o.getJSONArray("items")
    SharedTodos(o.getInt("generation"), o.getString("method"), List(a.length()) { sharedTodo(a.getJSONObject(it)) })
}

/** 실패한 요청은 완료로 바꾸지 않습니다. 범위·요청 번호가 달라진 응답은 어떤 화면 상태도 되살리지 않습니다. */
data class SharedTodoState(
    val scope: TodoScope? = null, val sequence: Long = 0, val data: SharedTodos? = null,
    val syncedAt: Long? = null, val loading: Boolean = false, val note: String = "",
) {
    val items get() = data?.items.orEmpty()
    fun bind(next: TodoScope?) = if (scope == next) this else SharedTodoState(scope = next, sequence = sequence + 1)
    fun begin(): Pair<SharedTodoState, TodoAttempt> {
        check(!loading); val current = requireNotNull(scope)
        return copy(sequence = sequence + 1, loading = true, note = "") to TodoAttempt(current, sequence + 1)
    }
    fun accepts(attempt: TodoAttempt) = scope == attempt.scope && sequence == attempt.sequence
    fun received(attempt: TodoAttempt, next: SharedTodos, at: Long): SharedTodoState = when {
        !accepts(attempt) -> this
        next.generation != scope?.generation -> copy(data = null, syncedAt = null, loading = false, note = "동의 상태가 바뀌었어요. 다시 확인해 주세요")
        else -> copy(data = next, syncedAt = at, loading = false, note = "")
    }
    fun failed(attempt: TodoAttempt, message: String, clear: Boolean = false) = if (!accepts(attempt)) this else
        copy(data = if (clear) null else data, syncedAt = if (clear) null else syncedAt, loading = false, note = message)
}

/** 처음 받은 P와 뒤늦은 UX 제한 해제는 도착이 아닙니다. 실제 P 외 기어를 본 다음에만 자동 확인합니다. */
data class ArrivalParkingGate(val armed: Boolean = false) {
    fun observe(gear: String?, restricted: Boolean): Pair<ArrivalParkingGate, Boolean> = when {
        gear == null -> ArrivalParkingGate() to false
        gear != "P" -> ArrivalParkingGate(armed = true) to false
        armed && !restricted -> ArrivalParkingGate() to true
        else -> this to false
    }
}

fun vehiclePoint(lat: Double?, lng: Double?): Boolean = lat != null && lng != null && lat.isFinite() && lng.isFinite() &&
    lat in -90.0..90.0 && lng in -180.0..180.0 && !(lat == 0.0 && lng == 0.0)
fun arrivalPlace(name: String?, lat: Double?, lng: Double?): Place? =
    if (name.isNullOrBlank() || !vehiclePoint(lat, lng)) null else Place(lat!!, lng!!, name)

data class VehicleArrival(val place: Place, val lat: Double, val lng: Double, val observedAt: Long) {
    fun body(generation: Int, parked: Boolean): JSONObject {
        require(vehiclePoint(place.lat, place.lng) && vehiclePoint(lat, lng) && place.name.isNotBlank())
        return JSONObject().put("generation", generation).put("source", "vehicle").put("parked", parked).put("observedAt", observedAt)
            .put("place", JSONObject().put("name", place.name).put("lat", place.lat).put("lng", place.lng))
            .put("position", JSONObject().put("lat", lat).put("lng", lng))
    }
}
data class SharedArrival(val generation: Int, val eligible: Boolean, val reason: String?, val observedAt: Long, val place: Place, val items: List<SharedTodo>)
fun sharedArrival(json: String): SharedArrival = JSONObject(json).let { o ->
    require(o.getString("source") == "vehicle")
    val a = o.getJSONArray("items")
    SharedArrival(o.getInt("generation"), o.getBoolean("eligible"), if (o.isNull("reason")) null else o.getString("reason"),
        o.getLong("observedAt"), o.getJSONObject("place").let { Place(it.getDouble("lat"), it.getDouble("lng"), it.getString("name")) }, List(a.length()) { sharedTodo(a.getJSONObject(it)) })
}
/** 응답 사이 출발·동의 변경·오래된 관측은 음성 안내에 쓰지 않습니다. 서버 eligible을 로컬에서 만들지 않습니다. */
fun canReadArrival(result: SharedArrival, request: VehicleArrival, scope: TodoScope, current: TodoScope?, parked: Boolean, now: Long): Boolean =
    scope == current && parked && result.eligible && result.generation == scope.generation && result.observedAt == request.observedAt && result.place == request.place &&
        now - request.observedAt in 0L..60_000L && result.items.all { it.pending }
fun sharedBriefingLine(place: String, items: List<SharedTodo>) = "${place}에 도착했어요. 할 일 ${items.size}건. " + items.joinToString(". ") { it.text }
