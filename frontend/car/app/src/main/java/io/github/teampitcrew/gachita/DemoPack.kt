package io.github.teampitcrew.gachita

import androidx.compose.runtime.mutableStateListOf
import android.content.Context
import android.graphics.BitmapFactory
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import kotlinx.coroutines.delay
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/*
 * mock: 시연 팩(T156, 오너 11/15). 디버그 빌드의 assets/demo/manifest.json(+ 영상·표지)이 있으면, 여행을 마친 뒤의 화면
 * (대화 기록 C44 · 여행 마무리 C22–C32 · 콘텐츠 기록 C33–C38)이 서버 대신 이 팩의 값을 읽는다. 실제 받아쓰기·쇼츠 생성은 시간이 걸려
 * 시연 영상에 담을 수 없어서다. 팩이 없으면(저장소·CI 빌드) 아무 일도 하지 않는다.
 * - 팩 내용(실제 대화·목소리가 든 영상)은 저장소에 넣지 않는다: app/src/debug/assets/demo/는 .gitignore, 채우기는 demo_pack.py(경로는 인자).
 * - 화면은 새로 만들지 않는다. 기존 화면이 읽는 값(Trip·TranscriptLine·AfterPick·ContentTrip) 모양으로 바꿔 끼운다.
 * 팩 형식(version 1) — 시각은 모두 여행 시작에서 잰 초:
 *   title, group, seconds(여행 길이), startedAt(epoch ms, 없으면 지금 여행을 만든 시각에 맞춤),
 *   people[{id, name, seat(Seat 이름), character(ShortCharacter 키)}],
 *   lines[{at, who(people id), text}], wave[초…](파형 막대용 발화 시각, 없으면 lines),
 *   route[{lat, lng, name?}](이름 있는 첫 점은 출발, 나머지 이름 있는 점은 도착),
 *   scenes[{id, from, to, title, quote, who?, video(파일 이름), cover?(파일 이름), seconds(영상 길이), lat?, lng?}](추천 장면 = 완성 쇼츠)
 */

internal data class DemoPerson(val id: String, val name: String, val seat: String, val character: String)
internal data class DemoLine(val at: Double, val who: String, val text: String)
internal data class DemoPoint(val lat: Double, val lng: Double, val name: String?)
internal data class DemoScene(val id: String, val from: Double, val to: Double, val title: String, val quote: String, val who: String?,
    val video: String, val cover: String?, val seconds: Double, val lat: Double?, val lng: Double?)

/** 도착 할 일 한 줄(도착 전 카드 C19·도착 브리핑 C20): category는 first·buy·remember·bring, by는 부탁한 사람 id. */
internal data class DemoAsk(val category: String, val title: String, val items: List<String>, val by: String?)
/** 들르는 곳: nearAt(초)부터 도착 전 카드, briefAt부터 도착 브리핑. final이면 최종 목적지(브리핑 '계속'이 여행을 마친다). */
internal data class DemoStop(val name: String, val nearAt: Double, val briefAt: Double, val final: Boolean, val asks: List<DemoAsk>) {
    fun todos(): List<SharedTodo> = asks.mapIndexed { i, a ->
        SharedTodo("demo-$name-$i", name, a.title, "pending", 0, emptyList(), a.category, a.items.map { TodoItem(it, null) }, listOfNotNull(a.by), a.title)
    }
}
internal data class DemoPack(val title: String, val group: String, val seconds: Double, val startedAt: Long?, val people: List<DemoPerson>,
    val lines: List<DemoLine>, val wave: List<Double>, val route: List<DemoPoint>, val scenes: List<DemoScene>, val stops: List<DemoStop> = emptyList()) {
    private fun origin(trip: Trip) = startedAt ?: trip.createdAt
    private fun ms(seconds: Double) = Math.round(seconds * 1000)
    private val names get() = people.associate { it.id to it.name }
    /** 운전석 사람(대화 기록의 '(나)'). */
    val driver get() = people.firstOrNull { it.seat == Seat.ROW_1_LEFT.name }?.id
    /** 마지막 도착지 이름(C22 '○○ 도착'). */
    val arrival get() = route.lastOrNull { it.name != null }?.name

    /** 경로 점마다 여행 시작에서 잰 초: 길이에 비례(점이 겹쳐 길이가 0이면 순서에 비례). */
    private val routeSeconds: List<Double> get() {
        val run = route.runningFold(0.0 to route.first()) { (d, a), b -> d + Math.hypot(b.lat - a.lat, (b.lng - a.lng) * Math.cos(Math.toRadians(a.lat))) to b }.drop(1).map { it.first }
        val total = run.last()
        return run.mapIndexed { i, d -> seconds * (if (total > 0) d / total else i.toDouble() / (route.size - 1)) }
    }

    /** 팩의 사람·제목으로 바꾼 여행(코드·세대·상태는 지금 여행 그대로). 실제 계정의 이름과 달라도 화면은 팩 값을 쓴다. */
    fun trip(raw: Trip): Trip = raw.copy(title = title, createdAt = origin(raw), moments = emptyList(),
        people = people.map { Person(it.id, it.name, it.seat, consent = true, profile = true, character = it.character) })

    fun transcript(trip: Trip): List<TranscriptLine> = lines.mapIndexed { i, l -> TranscriptLine("demo", i + 1, origin(trip) + ms(l.at), l.text, l.who, false) }

    fun tripPlaces(trip: Trip): List<TripPlace> = contentPlaces(trip).map { TripPlace(it.name, it.at, it.kind) }

    private fun contentPlaces(trip: Trip): List<ContentPlace> {
        val at = routeSeconds
        val named = route.indices.filter { route[it].name != null }
        return named.mapIndexed { n, i -> ContentPlace(if (n == 0) "start" else "arrived", route[i].name!!, origin(trip) + ms(at[i]), route[i].lat, route[i].lng) }
    }

    fun afterLines(trip: Trip): List<AfterLine> = lines.mapIndexed { i, l -> AfterLine(i + 1L, origin(trip) + ms(l.at), l.text, l.who, l.who) }

    /** 파형 막대에 셀 발화 시각. */
    fun waveAt(trip: Trip): List<Long> = (wave.ifEmpty { lines.map { it.at } }).map { origin(trip) + ms(it) }

    /** 여행의 처음과 끝. */
    fun range(trip: Trip): Pair<Long, Long> = origin(trip) to origin(trip) + ms(seconds)

    /** 추천 장면(C23): 팩의 장면 그대로(차 안 후보 규칙을 돌리지 않는다). */
    fun picks(trip: Trip): List<AfterPick> = scenes.mapIndexed { i, s ->
        AfterPick(i + 1, origin(trip) + ms(s.from), origin(trip) + ms(s.to), origin(trip) + ms(s.from), s.title, "“${s.quote}”", s.who, s.lat, s.lng, clipText(s.quote, 30))
    }

    /** 콘텐츠 기록(C33–C38)이 읽는 여행: 팩의 쇼츠 전부, 경로, 출발·도착. 장면 id가 쇼츠 id이자 momentId다(C32 표지 → 플레이어). */
    fun contentTrip(trip: Trip): ContentTrip {
        val o = origin(trip)
        val members = people.map { ContentPerson(it.id, it.name, it.character, it.seat) }
        val places = contentPlaces(trip)
        val at = routeSeconds
        val items = scenes.map { s ->
            val who = members.firstOrNull { it.id == s.who }
            ContentItem(s.id, s.title, s.seconds, o + ms(s.from), o + ms(s.from), s.lat, s.lng, null, "generated",
                (listOfNotNull(who) + members.filter { it !== who }), listOf(ContentLine(o + ms(s.from), s.who, names[s.who], s.quote)), "", s.id)
        }.map { x -> x.copy(place = places.firstOrNull { it.kind == "arrived" && it.at > x.at }?.let { "${it.name} 가는 길" }) } // 시안 '○○ 가는 길': 다음 도착지
        return ContentTrip(trip.code, title, o, members, places, route.map { it.lat to it.lng }, items, o, o + ms(seconds), at.map { o + ms(it) }, group)
    }
}

private fun JSONObject.text(key: String): String = optString(key).trim().also { require(it.isNotEmpty()) { "$key 가 비었어요" } }
private fun JSONObject.real(key: String): Double = optDouble(key).also { require(!it.isNaN() && !it.isInfinite()) { "$key 는 숫자여야 해요" } }
private fun JSONObject.realOrNull(key: String): Double? = if (!has(key) || isNull(key)) null else real(key)
private fun <T> JSONArray?.each(f: (JSONObject) -> T): List<T> = if (this == null) emptyList() else (0 until length()).map { f(getJSONObject(it)) }
/** 팩 폴더 안의 파일 이름만(경로·숨김 파일 아님). */
private fun fileName(s: String): String = s.also { require(Regex("[A-Za-z0-9][A-Za-z0-9._-]*").matches(it)) { "파일 이름이 아니에요: $it" } }

/**
 * manifest.json을 읽고 확인한다. 틀리면 IllegalArgumentException(무엇이 틀렸는지) — 반쯤 맞는 팩으로 화면을 그리지 않는다.
 * 확인: version 1, 사람(id 겹침 없음, 자리는 Seat 이름), 모든 줄의 화자가 팩의 사람(미확인 줄 없음), 시각은 여행 안,
 * 장면은 구간이 앞뒤 맞고 영상 파일 이름이 있음, 경로는 두 점 이상이고 좌표가 범위 안.
 */
internal fun parseDemoPack(json: String): DemoPack {
    val o = JSONObject(json)
    require(o.optInt("version") == 1) { "version 1만 읽어요" }
    val seconds = o.real("seconds"); require(seconds > 0) { "seconds 는 0보다 커야 해요" }
    fun inTrip(t: Double, what: String) = t.also { require(it in 0.0..seconds) { "$what 시각이 여행 밖이에요: $it" } }
    val people = o.optJSONArray("people").each { p ->
        DemoPerson(p.text("id"), p.text("name"), p.text("seat").also { s -> require(Seat.entries.any { it.name == s }) { "모르는 자리: $s" } }, p.optString("character"))
    }
    require(people.isNotEmpty()) { "people 이 비었어요" }
    require(people.map { it.id }.toSet().size == people.size) { "사람 id가 겹쳐요" }
    val ids = people.map { it.id }.toSet()
    val lines = o.optJSONArray("lines").each { l ->
        DemoLine(inTrip(l.real("at"), "줄"), l.text("who").also { require(it in ids) { "줄의 화자가 팩에 없어요: $it" } }, l.text("text"))
    }.sortedBy { it.at }
    val wave = o.optJSONArray("wave")?.let { a -> (0 until a.length()).map { a.getDouble(it) }.filter { it in 0.0..seconds } }.orEmpty()
    val route = o.optJSONArray("route").each { p ->
        DemoPoint(p.real("lat").also { require(it in -90.0..90.0) { "위도가 범위 밖이에요" } }, p.real("lng").also { require(it in -180.0..180.0) { "경도가 범위 밖이에요" } },
            p.optString("name").trim().ifEmpty { null })
    }
    require(route.size >= 2) { "route 는 두 점 이상이어야 해요" }
    val scenes = o.optJSONArray("scenes").each { s ->
        val from = inTrip(s.real("from"), "장면"); val to = inTrip(s.real("to"), "장면")
        require(to > from) { "장면 구간의 끝이 시작보다 앞이에요" }
        val who = s.optString("who").trim().ifEmpty { null }?.also { require(it in ids) { "장면의 화자가 팩에 없어요: $it" } }
        DemoScene(s.text("id"), from, to, s.text("title"), s.text("quote"), who, fileName(s.text("video")),
            s.optString("cover").trim().ifEmpty { null }?.let(::fileName), s.real("seconds").also { require(it > 0) { "영상 길이는 0보다 커야 해요" } },
            s.realOrNull("lat"), s.realOrNull("lng"))
    }.sortedBy { it.from }
    require(scenes.isNotEmpty()) { "scenes 가 비었어요" }
    require(scenes.map { it.id }.toSet().size == scenes.size) { "장면 id가 겹쳐요" }
    val stops = (o.optJSONArray("stops")?.each { st ->
        val nearAt = inTrip(st.real("nearAt"), "들르는 곳"); val briefAt = inTrip(st.real("briefAt"), "들르는 곳")
        require(briefAt >= nearAt) { "도착 브리핑이 도착 전 카드보다 앞이에요" }
        DemoStop(st.text("name"), nearAt, briefAt, st.optBoolean("final"), st.optJSONArray("asks").each { a ->
            DemoAsk(a.text("category").also { require(it in setOf("first", "buy", "remember", "bring")) { "모르는 할 일 종류: $it" } }, a.text("title"),
                a.optJSONArray("items")?.let { x -> (0 until x.length()).map { x.getString(it) } }.orEmpty(),
                a.optString("by").trim().ifEmpty { null }?.also { require(it in ids) { "할 일을 부탁한 사람이 팩에 없어요: $it" } })
        })
    } ?: emptyList()).sortedBy { it.nearAt }
    return DemoPack(o.text("title"), o.text("group"), seconds, if (o.has("startedAt") && !o.isNull("startedAt")) o.getLong("startedAt") else null,
        people, lines, wave, route, scenes, stops)
}

/** [index]째 줄이 나오기까지 기다릴 시간: 팩의 시각 그대로(실시간) — 편집에서 같은 구간의 소리를 붙이면 줄과 맞는다(오너 11/15). 겹친 말도 0.3초는 띄운다. */
internal fun demoGapMs(lines: List<DemoLine>, index: Int): Long =
    Math.round((lines[index].at - (if (index == 0) 0.0 else lines[index - 1].at)) * 1000).coerceIn(300, 120_000)

/** 이 앱에 든 시연 팩(디버그 빌드의 assets/demo). 없거나 틀리면 pack은 null이고 앱은 평소대로 돈다. */
internal object Demo {
    private const val DIR = "demo"
    var pack by mutableStateOf<DemoPack?>(null)
        private set
    /** 장면 id → 표지 그림(일꾼이 만든 800×1100 종이 표지). */
    val covers = mutableStateMapOf<String, ImageBitmap>()

    /** 앱을 켤 때 한 번(디버그 빌드만 부른다). 표지 그림까지 읽은 뒤에 pack을 채운다. */
    fun load(context: Context) {
        val assets = context.applicationContext.assets
        if (pack != null || assets.list(DIR)?.contains("manifest.json") != true) return
        Thread {
            runCatching {
                val p = parseDemoPack(assets.open("$DIR/manifest.json").use { it.readBytes().decodeToString() })
                p.scenes.forEach { s -> s.cover?.let { name -> runCatching { assets.open("$DIR/$name").use(BitmapFactory::decodeStream)?.asImageBitmap() }.getOrNull()?.let { covers[s.id] = it } } }
                pack = p
                Log.i("GachitaDemo", "시연 팩 읽음: 줄 ${p.lines.size}, 장면 ${p.scenes.size}")
            }.onFailure { Log.w("GachitaDemo", "시연 팩을 읽지 못함: ${it.message}") }
        }.start()
    }

    // 주행 중 '방금 받아 적은 말'(C17): 기록하는 동안 팩의 줄을 차례로 하나씩 낸다. 지금까지 낸 줄 수는 여행마다 하나(앱이 켜져 있는 동안).
    private var heardTrip by mutableStateOf<String?>(null)
    private var heardCount by mutableIntStateOf(0)
    private val passed = mutableStateListOf<String>() // '계속'으로 닫은 들르는 곳
    /** 지금 보일 들르는 곳과 단계(false: 도착 전 카드, true: 도착 브리핑). 낸 줄의 시각을 시계로 쓴다. */
    fun stop(code: String, pack: DemoPack): Pair<DemoStop, Boolean>? {
        val at = pack.lines.getOrNull(heard(code) - 1)?.at ?: return null
        return pack.stops.lastOrNull { it.nearAt <= at && it.name !in passed }?.let { it to (at >= it.briefAt) }
    }
    fun pass(name: String) { if (name !in passed) passed.add(name) }
    /** 이 여행에서 지금까지 낸 줄 수. */
    fun heard(code: String): Int = if (heardTrip == code) heardCount else 0
    /** 기록 중인 동안 부른다(멈추면 취소 → 다시 부르면 이어 감). 다 내면 끝나고 되풀이하지 않는다. */
    suspend fun feed(code: String, pack: DemoPack) {
        if (heardTrip != code) { heardTrip = code; heardCount = 0; passed.clear() }
        while (heardCount < pack.lines.size) { delay(demoGapMs(pack.lines, heardCount)); heardCount++ }
    }

    /** 장면의 영상을 캐시 파일로 꺼낸다(플레이어는 파일을 읽는다). */
    fun video(context: Context, id: String): File {
        val scene = requireNotNull(pack?.scenes?.firstOrNull { it.id == id }) { "영상을 불러오지 못했어요" }
        return File.createTempFile("content-", ".mp4", context.cacheDir).also { f ->
            context.assets.open("$DIR/${scene.video}").use { i -> f.outputStream().use { i.copyTo(it) } }
        }
    }
}
