package io.github.teampitcrew.gachita

import org.json.JSONObject
import kotlin.math.cos
import kotlin.math.hypot

// 부탁을 경유지로(T9)에서 화면·SDK와 무관한 규칙(단위 테스트 AsksTest.kt). 흐름은 MainActivity, 내비 호출은 Car.kt.

/**
 * 강릉 가는 길(영동고속도로 강릉방향) 휴게소. 좌표는 카카오 장소 검색(2026-11-13), 서울 → 강릉 순서.
 * 서버의 경로 위 휴게소 추천(T97)을 받지 못할 때(서버 꺼짐·오프라인·위치 모름)만 쓴다. 시연은 오프라인에서도 돌아야 한다.
 */
val REST_STOPS = listOf(
    Place(37.2455536, 127.2423181, "용인휴게소 강릉방향"),
    Place(37.2413394, 127.3898467, "덕평자연휴게소"),
    Place(37.2378926, 127.5696329, "여주맛있는휴게소 강릉방향"),
    Place(37.3352003, 127.8582007, "문막휴게소 강릉방향"),
    Place(37.4628673, 128.1339886, "횡성휴게소 강릉방향"),
    Place(37.6053670, 128.4529472, "평창휴게소 강릉방향"),
    Place(37.7573639, 128.8065980, "강릉대관령휴게소 강릉방향"),
)

/** 시연 여행의 목적지이자 이 길의 끝. 휴게소를 지나쳤는지 재는 기준이다. */
val GANGNEUNG = Place(37.7645236, 128.8996276, "강릉역")

/** 말할 때 쓰는 이름: "용인휴게소 강릉방향" → "용인휴게소". */
val Place.spoken: String get() = name.substringBefore(" ")

/** 두 점 사이의 대략 거리(m). 몇 km 단위로 앞뒤만 가리면 되어 평면 근사로 충분하다. */
fun meters(aLat: Double, aLng: Double, bLat: Double, bLng: Double): Double =
    hypot((bLat - aLat) * 111_000, (bLng - aLng) * 111_000 * cos(Math.toRadians((aLat + bLat) / 2)))

/**
 * 지금 위치에서 아직 지나치지 않은 가장 가까운 휴게소. 위치를 모르면 첫 곳.
 * 지나쳤는지는 '길의 끝(강릉역)까지 지금보다 가까운가'로 본다. 서쪽에서 동쪽으로 거의 곧게 가는 길이라 맞는다.
 * ponytail: 직선 거리 비교. 길이 크게 휘는 경로를 넣으면 경로 위 거리(내비의 남은 거리)로 바꾼다.
 */
fun nextStop(lat: Double?, lng: Double?, stops: List<Place> = REST_STOPS, end: Place = GANGNEUNG): Place? {
    if (lat == null || lng == null || (lat == 0.0 && lng == 0.0)) return stops.firstOrNull()
    val here = meters(lat, lng, end.lat, end.lng)
    return stops.filter { meters(it.lat, it.lng, end.lat, end.lng) < here }.minByOrNull { meters(lat, lng, it.lat, it.lng) }
}

/** 서버 추천(POST /api/rest-stops, T97)의 답을 휴게소 목록으로. 좋은 순. */
fun restStopsOf(json: String): List<Place> = JSONObject(json).getJSONArray("items").let { a ->
    List(a.length()) { i -> a.getJSONObject(i).let { Place(it.getDouble("lat"), it.getDouble("lng"), it.getString("name")) } }
}

/** 제안 후보: 서버가 답했으면 그 답(빈 목록이면 앞에 들를 곳이 없음), 서버를 쓸 수 없으면(실패·꺼짐·오프라인) 고정 목록. */
fun stopsFrom(server: Result<List<Place>>, lat: Double?, lng: Double?): List<Place> = server.getOrElse { listOfNotNull(nextStop(lat, lng)) }

/**
 * 내비가 잰 길 위 거리(road, requestTrip)로 본 '지금 길에서 들르는 곳'인가. 서버 추천은 직선 어림이라 나란한 고속도로나
 * 건너편 휴게소를 고를 수 있는데, 그런 곳은 분기점을 돌거나 되돌아와야 해 길 위 거리가 직선보다 훨씬 길다.
 * 목적지까지 남은 길(remain)보다 멀어도 아니다. 길 위 거리를 모르면 막지 않는다.
 * ponytail: 1.5배 + 2 km는 어림. 실차 기록이 쌓이면 맞춘다.
 */
fun onRoad(straight: Double, road: Int?, remain: Int?): Boolean =
    road == null || ((remain == null || road <= remain) && road <= straight * 1.5 + 2_000)

private fun squash(text: String) = text.replace(Regex("[^가-힣A-Za-z0-9]"), "")

/**
 * 쉬어 가자는 부탁인지. 낱말 규칙(11/13 실측과 같은 방식). 수락하는 말("응, 다음 휴게소 가자")은 부탁이 아니다.
 * ponytail: 낱말 몇 개. LLM 판정은 음성 처리 흐름(T12) 뒤에 바꾼다.
 */
fun isRestRequest(text: String): Boolean {
    val t = squash(text)
    return listOf("화장실", "쉬었다가", "쉬어가", "배고파").any { it in t }
}

enum class Answer { YES, NO, UNCLEAR }

// "안"·"네"처럼 흔한 낱말은 넣지 않는다("나 안 졸려", "네 동생은?"). '안'은 "안 가", "안 들러"로만 본다
private val NO_WORDS = setOf("아니", "아니야", "아니요", "아뇨", "나중에", "괜찮아", "괜찮아요", "싫어", "됐어")
private val NO_PHRASE = Regex("안 ?(가|들러)")
private val YES_WORDS = setOf("응", "그래", "그래요", "좋아", "좋아요", "가자", "들르자", "들렀다")

/**
 * 제안("…에 들를까요?")에 대한 답. 띄어쓰기로 나눈 낱말이 통째로 같아야 한다("그래서", "좋아하는", "반응"은 답이 아니다).
 * 거절 낱말이 먼저다("아니 가자고 안 했어"는 거절).
 */
fun answerOf(text: String): Answer {
    val words = text.split(Regex("[^가-힣A-Za-z0-9]+")).toSet()
    return when {
        words.any { it in NO_WORDS } || NO_PHRASE.containsMatchIn(text) -> Answer.NO
        words.any { it in YES_WORDS } -> Answer.YES
        else -> Answer.UNCLEAR
    }
}

/** 수락은 앞줄(좌석 구역 0)이나 구역을 모르는 말만 받는다. 뒷줄 아이의 "응"으로 경로가 바뀌지 않게(T37이 구역을 붙임). */
fun canAccept(u: Utterance) = u.seatZone == null || u.seatZone == 0

/**
 * 받아 적은 말의 첫 중간 결과가 우리 TTS가 말하는 동안(끝난 뒤 0.3초까지) 왔는지. 스피커 소리가 마이크로 되돌아오면
 * 우리가 읽은 할 일·제안이 다시 받아 적혀 판정될 수 있다. 말이 끝난 뒤 바로 한 "응"은 첫 결과가 0.4초 넘게 걸려(11/13) 걸리지 않는다.
 * ponytail: 실차에서 되돌아오는지는 재지 않았다(에뮬레이터는 되돌아오지 않음). 차의 에코 제거가 막아 주면 필요 없다.
 */
fun overlapsSpeech(firstPartialAt: Long, from: Long, to: Long) = from > 0 && firstPartialAt in from..(if (to == Long.MAX_VALUE) to else to + 300)

/** 내비가 앞에 있어도 읽히는 거리·시간. 모르면 빈 글자. */
fun distanceLabel(meters: Int?, seconds: Int?): String = listOfNotNull(
    meters?.let { if (it >= 1000) "%.0f km".format(it / 1000.0) else "$it m" },
    seconds?.let { "${maxOf(1, (it + 59) / 60)}분" },
).joinToString(" · ")

/**
 * 경유지 제안 하나. 한 번에 하나만 열리고, 같은 휴게소에 묶인 부탁들(서버 id)과 단계를 갖는다.
 * FINDING 휴게소와 거리를 내비에 묻는 중 → ASKING 제안을 보이고 답을 기다림 → ADDING 내비에 넣는 중
 * → ADDED 반영됨 / FAILED 못 넣어 보관으로 되돌림. id는 늦게 온 콜백이 다른 제안을 건드리지 않게 하는 번호.
 */
data class Offer(
    val id: Long, val trip: String, val requests: List<String> = emptyList(), val stop: Place? = null,
    val meters: Int? = null, val seconds: Int? = null, val stage: Stage = Stage.FINDING, val asked: Int = 1,
) {
    enum class Stage { FINDING, ASKING, ADDING, ADDED, FAILED }
}
