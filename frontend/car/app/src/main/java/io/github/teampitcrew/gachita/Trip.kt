package io.github.teampitcrew.gachita

import org.json.JSONObject

/** Pleos Vehicle SDK의 SeatArea 이름(API의 Seat). */
enum class Seat(val label: String) {
    ROW_1_LEFT("운전석"), ROW_1_RIGHT("조수석"), ROW_2_LEFT("뒷자리 왼쪽"), ROW_2_CENTER("뒷자리 가운데"), ROW_2_RIGHT("뒷자리 오른쪽")
}

data class Member(val name: String, val seat: Seat)

/**
 * 가족 프로필. 서버에 가족 목록 API가 없어 앱 안에 두고 손님으로 참가시킨다.
 * ponytail: 고정 목록. 가족 그룹 API(T45, ADR-0009)가 생기면 그 응답으로 바꾼다.
 */
val FAMILY = listOf(
    Member("아빠", Seat.ROW_1_LEFT), Member("엄마", Seat.ROW_1_RIGHT),
    Member("서준", Seat.ROW_2_LEFT), Member("하은", Seat.ROW_2_RIGHT),
)

data class Person(val id: String, val name: String, val seat: String, val consent: Boolean)

data class Trip(val code: String, val title: String, val status: String, val people: List<Person>, val heldRequests: Int, val version: Int)

/** GET·POST /api/trips 응답(openapi.yaml의 Trip)을 읽는다. 보관한 부탁은 status가 held인 것만 센다. */
fun parseTrip(json: String): Trip {
    val o = JSONObject(json)
    val ps = o.getJSONArray("participants")
    val rs = o.getJSONArray("requests")
    return Trip(
        code = o.getString("code"),
        title = o.optString("title"),
        status = o.getString("status"),
        people = List(ps.length()) { i ->
            ps.getJSONObject(i).let { Person(it.getString("id"), it.getString("name"), it.getString("seat"), it.getBoolean("consent")) }
        },
        heldRequests = (0 until rs.length()).count { rs.getJSONObject(it).getString("status") == "held" },
        version = o.getInt("version"),
    )
}

/**
 * 차량 앱이 보는 여행 하나의 상태. 화면은 이 값만 보고 그린다.
 *
 * 기록 동의 규칙(T7):
 * - 기본값은 꺼짐. 참가자는 동의 꺼짐으로 만든다.
 * - 켜기는 기어 P이고 서버에 닿을 때만. 서버가 모두의 동의를 받아 준 뒤에야 '기록 중'이 된다.
 * - 끄기는 바로 멈춘다. 서버에 아직 못 알렸으면 offPending으로 꺼 두고, 서버 값이 꺼짐이 될 때까지 다시 보낸다.
 * - 폰에서 누가 동의를 끄면(서버 값) 기록도 멈춘다.
 */
data class Session(
    val trip: Trip? = null,
    val online: Boolean = true,
    val gear: String? = null,
    val offPending: Boolean = false,
    val busy: Boolean = false,
    val note: String = "",
) {
    val consented: Boolean get() = trip != null && trip.people.isNotEmpty() && trip.people.all { it.consent }
    val recording: Boolean get() = consented && !offPending

    /** 동의를 켤 수 없으면 그 이유. 켤 수 있으면 null. */
    fun blockOn(): String? = when {
        trip == null -> "여행이 없어요"
        busy -> "처리하고 있어요"
        !online -> "연결이 끊겨 기록을 시작할 수 없어요"
        gear == null -> "기어를 확인할 수 없어 기록을 시작하지 않았어요"
        gear != "P" -> "주차(P)한 뒤에 켤 수 있어요"
        else -> null
    }

    /** 서버에서 받은 최신 여행을 반영한다. 서버도 모두 꺼짐이면 끄기 대기를 푼다. */
    fun withTrip(t: Trip) = copy(trip = t, online = true, offPending = offPending && t.people.any { it.consent })

    /** 켜기: 서버가 모두의 동의를 저장한 뒤의 여행으로 부른다. 앞서 남은 끄기 대기는 지운다. */
    fun turnedOn(t: Trip) = copy(offPending = false).withTrip(t)

    /** 끄기: 서버 응답을 기다리지 않고 바로 멈춘다. */
    fun turnOff() = copy(offPending = true)
}
