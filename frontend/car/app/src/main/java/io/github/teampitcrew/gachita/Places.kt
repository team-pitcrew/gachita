package io.github.teampitcrew.gachita

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** 차가 서버에 남기는 장소 한 건(POST /api/trips/{code}/places, T131). at은 관측 시각이라 끊겼다 늦게 보내도 제자리에 들어간다. */
data class PlaceNote(val kind: String, val name: String, val at: Long, val generation: Int, val lat: Double? = null, val lng: Double? = null, val etaSeconds: Int? = null) {
    fun body(): JSONObject = JSONObject().put("kind", kind).put("name", name.take(100)).put("at", at).apply {
        if (lat != null && lng != null) put("lat", lat).put("lng", lng)
        etaSeconds?.let { put("etaSeconds", it) }
    }
    fun json(): JSONObject = body().put("generation", generation)
    companion object {
        fun parse(o: JSONObject) = PlaceNote(o.getString("kind"), o.getString("name"), o.getLong("at"), o.getInt("generation"),
            if (o.has("lat")) o.getDouble("lat") else null, if (o.has("lng")) o.getDouble("lng") else null, if (o.has("etaSeconds")) o.getInt("etaSeconds") else null)
    }
}

/**
 * 여행 하나의 장소 기록(T131): 10초 조회마다 내비 상태를 see()로 받아 출발·목적지를, 주행 중 '곧 도착'(C19, Drive.kt approach)이 approach()로,
 * 도착 판정(T113)이 arrived()로 도착·경유를 정한다. 차가 /places에 보내는 것은 이 클래스 하나로 모은다.
 * 같은 일을 두 번 남기지 않게 마지막 상태와 못 보낸 것을 places-<여행>.json에 통째로 암호화해 다시 쓴다(몇십 건이라 충분, Todos와 같은 방식).
 * 화면이 모두 동의한 동안에만 부르고, 동의 세대가 오르면(누군가 철회) 옛 세대에 쌓인 것은 보내지 않고 버린다. 메인 스레드에서만 만진다.
 * ponytail: 보낸 뒤 응답을 잃으면(끊김) 같은 장소가 한 번 더 남을 수 있다. 서버에 요청 키가 생기면 그것으로 막는다.
 */
class PlaceLog(dir: File, val trip: String, private val seal: Seal) {
    private val file = File(dir, "places-$trip.json")
    private var started = false
    private var dest: String? = null // 마지막으로 남긴 목적지 이름
    private var near: String? = null // 마지막으로 남긴 '곧 도착'(장소|남은 분). 같은 분 안에는 다시 남기지 않는다
    private var here: String? = null // 마지막으로 남긴 도착·경유. 다시 움직이면 지운다(같은 곳에 머무는 동안 한 번만)
    private var generation = 1
    var queue: List<PlaceNote> = emptyList()
        private set

    init {
        runCatching { JSONObject(seal.unline(file.readText())) }.getOrNull()?.let { o ->
            started = o.optBoolean("started"); generation = o.optInt("generation", 1)
            dest = o.optString("dest").ifEmpty { null }; near = o.optString("near").ifEmpty { null }; here = o.optString("here").ifEmpty { null }
            queue = o.optJSONArray("queue")?.let { a -> List(a.length()) { PlaceNote.parse(a.getJSONObject(it)) } }.orEmpty()
        }
    }

    /** 동의 세대가 오르면 옛 세대에 쌓인 것을 버린다. */
    private fun at(g: Int) { if (g > generation) { generation = g; queue = queue.filter { it.generation >= g } } }

    /** 10초 조회 한 번의 내비 상태. moving은 기어가 P가 아님, destination은 내비 목적지(이름·좌표), fix는 마지막 위치. 바뀐 것이 있으면 true. */
    fun see(moving: Boolean, destination: Place?, fix: Fix?, g: Int, now: Long): Boolean {
        at(g)
        val add = ArrayList<PlaceNote>()
        if (moving) here = null
        if (moving && !started) { started = true; add += PlaceNote("start", "출발", now, generation, fix?.lat, fix?.lng) }
        if (destination != null && destination.name != dest) {
            dest = destination.name
            add += PlaceNote("destination", destination.name, now, generation, destination.lat, destination.lng)
        }
        if (add.isEmpty()) return false
        queue = queue + add; save(); return true
    }

    /** 곧 도착(다음 장소: 첫 경유지 또는 목적지, 남은 시간 5분 이하). 같은 장소·같은 분에 한 번 — 폰(P19)이 남은 분을 새로 받는다. */
    fun approach(place: String, minutes: Int, seconds: Int, g: Int, now: Long): Boolean {
        at(g)
        val key = "$place|$minutes"
        if (near == key) return false
        near = key
        queue = queue + PlaceNote("approaching", place, now, generation, etaSeconds = seconds)
        save(); return true
    }

    /** 도착 판정이 그곳에 닿았다고 본 때. final(남은 경유지 없음, 내비 목적지)이면 도착, 아니면 경유지에 들름. 같은 곳에 머무는 동안은 한 번만. */
    fun arrived(place: Place, final: Boolean, g: Int, observedAt: Long): Boolean {
        at(g)
        if (here == place.name) return false
        here = place.name
        queue = queue + PlaceNote(if (final) "arrived" else "stop", place.name, observedAt, generation, place.lat, place.lng)
        save(); return true
    }

    /** 보낼 다음 것(지금 세대). */
    fun next(g: Int): PlaceNote? { at(g); return queue.firstOrNull { it.generation == generation } }

    /** 서버가 받았거나 받지 않는 값(400)이라 버림. */
    fun done(n: PlaceNote) { queue = queue - n; save() }

    /** 임시 파일에 다 쓴 뒤 이름을 바꾼다. 실패하면 이번 실행의 메모리 값으로 잇는다. */
    private fun save() = runCatching {
        val o = JSONObject().put("started", started).put("generation", generation).put("dest", dest ?: "").put("near", near ?: "").put("here", here ?: "")
            .put("queue", JSONArray(queue.map { it.json() }))
        val tmp = File(file.path + ".tmp")
        tmp.writeText(seal.line(o.toString())); tmp.renameTo(file)
    }
}
