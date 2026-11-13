package io.github.teampitcrew.gachita

import org.json.JSONObject

// 숏폼(T43)에서 화면·SDK와 무관한 것(단위 테스트 ShortTest.kt). 재생은 MainActivity.
// 숏폼은 영상 파일이 아니라 구성 데이터다: 장면마다 클립 소리 + 자막 큐 + 말한 사람(GET /api/trips/{code}/shortform, #63 계약).

/** 자막 한 줄. start·end는 클립 처음부터의 초. who는 말한 사람 이름, 못 붙였으면 자리 구역, 둘 다 없으면 빈 글자. */
data class Cue(val start: Double, val end: Double, val text: String, val who: String)

data class Scene(val label: String, val clip: String, val seconds: Double, val cues: List<Cue>)

data class Short(val title: String, val scenes: List<Scene>)

/**
 * 숏폼 구성을 읽는다. 말한 사람은 cast의 이름으로, 못 붙인 큐(participantId null)는 자리 구역 이름으로만 적는다
 * (자리만으로 이름을 붙이지 않음, frontend/spec/after-trip.md).
 */
fun parseShort(json: String): Short {
    val o = JSONObject(json)
    val cast = o.optJSONArray("cast")
    val names = (0 until (cast?.length() ?: 0)).associate { i -> cast!!.getJSONObject(i).let { it.getString("participantId") to it.getString("name") } }
    val ss = o.getJSONArray("scenes")
    return Short(
        title = o.optString("title"),
        scenes = List(ss.length()) { i ->
            val s = ss.getJSONObject(i)
            val cs = s.getJSONArray("cues")
            Scene(
                label = s.optString("label"),
                clip = s.getString("clip"),
                seconds = s.getDouble("seconds"),
                cues = List(cs.length()) { j ->
                    val c = cs.getJSONObject(j)
                    val pid = if (c.isNull("participantId")) null else c.optString("participantId")
                    val seat = if (c.isNull("seatArea")) null else c.optString("seatArea")
                    Cue(c.getDouble("start"), c.getDouble("end"), c.getString("text"),
                        pid?.let(names::get) ?: seat?.let { runCatching { Seat.valueOf(it).label }.getOrNull() } ?: "")
                },
            )
        },
    )
}

/** t초에 보일 자막. 같이 말해 겹치면 나중에 시작한 줄. 없으면 null. */
fun cueAt(cues: List<Cue>, t: Double): Cue? = cues.lastOrNull { t >= it.start && t < it.end }

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
