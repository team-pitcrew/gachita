package io.github.teampitcrew.gachita

import org.json.JSONObject

// 숏폼(T43)에서 화면·SDK와 무관한 것(단위 테스트 ShortTest.kt). 재생은 MainActivity.
// 숏폼은 영상 파일이 아니라 구성 데이터다: 장면마다 클립 소리 + 자막 큐 + 말한 사람(GET /api/trips/{code}/shortform, #63 계약).

/** 자막 한 줄. start·end는 클립 처음부터의 초. who는 말한 사람 이름, 못 붙였으면 자리 구역, 둘 다 없으면 빈 글자. */
data class Cue(val start: Double, val end: Double, val text: String, val who: String, val participantId: String? = null)

data class Scene(val label: String, val clip: String, val seconds: Double, val cues: List<Cue>, val momentId: String = "")

data class ShortCast(val participantId: String, val name: String, val character: String, val seat: String)

data class Short(val title: String, val scenes: List<Scene>, val generation: Int = 1, val cast: List<ShortCast> = emptyList())

/**
 * 숏폼 구성을 읽는다. 말한 사람은 cast의 이름으로, 못 붙인 큐(participantId null)는 자리 구역 이름으로만 적는다
 * (자리만으로 이름을 붙이지 않음, frontend/spec/after-trip.md).
 */
fun parseShort(json: String): Short {
    val o = JSONObject(json)
    val rawCast = o.optJSONArray("cast")
    val cast = List(rawCast?.length() ?: 0) { i -> rawCast!!.getJSONObject(i).let {
        ShortCast(it.getString("participantId"), it.getString("name"), it.optString("character", ""), it.optString("seat", ""))
    } }
    val names = cast.groupBy { it.participantId }.filter { (id, entries) -> id.isNotBlank() && entries.size == 1 }
        .mapValues { (_, entries) -> entries.single().name }
    val ss = o.getJSONArray("scenes")
    return Short(
        title = o.optString("title"),
        generation = o.getInt("generation"),
        cast = cast,
        scenes = List(ss.length()) { i ->
            val s = ss.getJSONObject(i)
            val cs = s.getJSONArray("cues")
            Scene(
                label = s.optString("label"),
                momentId = s.optString("momentId"),
                clip = s.getString("clip"),
                seconds = s.getDouble("seconds"),
                cues = List(cs.length()) { j ->
                    val c = cs.getJSONObject(j)
                    val pid = if (c.isNull("participantId")) null else c.optString("participantId").takeIf { it.isNotBlank() }
                    val seat = if (c.isNull("seatArea")) null else c.optString("seatArea")
                    Cue(c.getDouble("start"), c.getDouble("end"), c.getString("text"),
                        pid?.let(names::get) ?: seat?.let { runCatching { Seat.valueOf(it).label }.getOrNull() } ?: "", pid)
                },
            )
        },
    )
}

/** t초에 보일 자막. 같이 말해 겹치면 나중에 시작한 줄. 없으면 null. */
fun cueAt(cues: List<Cue>, t: Double): Cue? = cues.lastOrNull { t >= it.start && t < it.end }

/** 폰에서 고른 키를 미리보기와 MP4가 같은 전신 PNG로 표시합니다. */
internal enum class ShortCharacter(val key: String, val drawable: Int) {
    BASIC("basic", R.drawable.char_basic), BASIC_SMALL("basic-small", R.drawable.char_basic_small),
    CAP("cap", R.drawable.char_cap), CAP_SMALL("cap-small", R.drawable.char_cap_small),
    GLASSES("glasses", R.drawable.char_glasses), GLASSES_SMALL("glasses-small", R.drawable.char_glasses_small),
    TRAVEL("travel", R.drawable.char_travel), TRAVEL_SMALL("travel-small", R.drawable.char_travel_small),
    GAME("game", R.drawable.char_game), GAME_SMALL("game-small", R.drawable.char_game_small),
    CAMPING("camping", R.drawable.char_camping), CAMPING_SMALL("camping-small", R.drawable.char_camping_small),
    HEALING("healing", R.drawable.char_healing), HEALING_SMALL("healing-small", R.drawable.char_healing_small),
    OFFICE("office", R.drawable.char_office), OFFICE_SMALL("office-small", R.drawable.char_office_small),
    PET("pet", R.drawable.char_pet), PET_SMALL("pet-small", R.drawable.char_pet_small),
    SPORT("sport", R.drawable.char_sport), SPORT_SMALL("sport-small", R.drawable.char_sport_small),
}

internal data class ShortSceneActor(val key: String, val label: String, val character: ShortCharacter?, val participantId: String? = null)

internal fun shortSceneActor(cue: Cue, cast: List<ShortCast>, people: List<Person>): ShortSceneActor {
    val id = cue.participantId?.takeIf { it.isNotBlank() }
    val person = id?.let { cast.singleOrNull { person -> person.participantId == it } }
    val participants = people.filter { it.id == id }
    if (person == null || participants.size > 1) return ShortSceneActor("unknown:${id.orEmpty()}:${cue.who}", cue.who.ifBlank { "화자 미확인" }, null)
    // 이름이나 자리로 화자를 추측하지 않습니다. 같은 ID의 확정 참가자에게만 설정을 붙입니다.
    val character = if (person.character.isNotBlank()) ShortCharacter.entries.singleOrNull { it.key == person.character }
    else if (participants.singleOrNull()?.profile == false) {
        val seat = person.seat.ifBlank { participants.single().seat }
        when (Seat.entries.firstOrNull { it.name == seat }) {
            Seat.ROW_1_LEFT -> ShortCharacter.BASIC
            Seat.ROW_1_RIGHT -> ShortCharacter.CAP
            Seat.ROW_2_LEFT -> ShortCharacter.GLASSES_SMALL
            Seat.ROW_2_CENTER -> ShortCharacter.TRAVEL_SMALL
            Seat.ROW_2_RIGHT -> ShortCharacter.BASIC_SMALL
            null -> null
        }
    } else null
    return ShortSceneActor("participant:$id", person.name.ifBlank { cue.who.ifBlank { "화자 미확인" } }, character, id)
}

/** 장면 전체의 첫 두 화자를 처음부터 두고, 세 번째 현재 화자만 오른쪽에 표시합니다. 두 렌더러가 이 계획을 공유합니다. */
internal fun shortSceneCast(short: Short, scene: Scene?, cue: Cue?, people: List<Person>): List<ShortSceneActor> {
    val cast = scene?.cues.orEmpty().map { shortSceneActor(it, short.cast, people) }.filter { it.participantId != null }
        .distinctBy { it.participantId }.take(2).toMutableList()
    while (cast.size < 2) cast += ShortSceneActor("unidentified:${cast.size}", "화자 미확인", null)
    cue?.let { shortSceneActor(it, short.cast, people) }?.let { current -> if (cast.none { it.key == current.key }) cast[1] = current }
    // 화자 미확인은 이름·ID를 추측하지 않고, 중립 캐릭터 두 종류로만 표현합니다.
    return cast.mapIndexed { slot, actor ->
        actor.copy(character = actor.character ?: if (slot == 0) ShortCharacter.BASIC else ShortCharacter.BASIC_SMALL)
    }
}

/**
 * 클립 주소: '/api/…'는 앱의 서버 주소에 붙이고, 절대 주소는 서버와 같은 호스트나 그 아래 이름(media.<서버>)일 때만 받는다.
 * 참가자 토큰을 머리말로 보내므로 다른 호스트로는 보내지 않는다. 받지 않으면 null.
 */
fun clipUrl(server: String, clip: String): String? {
    val base = server.trim().trimEnd('/')
    if (clip.startsWith("/")) return base + clip
    val host = java.net.URI(base).host ?: return null
    val u = runCatching { java.net.URI(clip) }.getOrNull() ?: return null
    return clip.takeIf { u.scheme == "https" && (u.host == host || u.host.orEmpty().endsWith(".$host")) }
}
