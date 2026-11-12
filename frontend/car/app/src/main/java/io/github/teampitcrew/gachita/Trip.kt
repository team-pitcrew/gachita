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
 * - 기록은 주차(P) 중에만 시작한다(started). 주행 중에 모두의 동의가 다시 채워지면(폰에서 다시 켬) '기록 대기'로 두고 P가 되면 시작한다.
 * - 끄기는 바로 멈춘다. 서버에 아직 못 알렸으면 offPending으로 꺼 두고, 서버 값이 꺼짐이 될 때까지 다시 보낸다.
 *   offPending과 started는 앱이 다시 켜져도 이어지게 저장한다(restore).
 * - 폰에서 누가 동의를 끄면(서버 값) 기록도 멈춘다.
 */
data class Session(
    val trip: Trip? = null,
    val online: Boolean = true,
    val gear: String? = null,
    val offPending: Boolean = false,
    val started: Boolean = false,
    val busy: Boolean = false,
    val note: String = "",
) {
    val consented: Boolean get() = trip != null && trip.people.isNotEmpty() && trip.people.all { it.consent }

    /** 동의 스위치에 보일 값: 모두 동의했고 끄기 대기가 없음. */
    val agreed: Boolean get() = consented && !offPending
    val recording: Boolean get() = agreed && started

    /** 모두 동의했지만 주행 중에 채워져 주차하면 시작하는 상태. */
    val waiting: Boolean get() = agreed && !started

    /** 동의가 빠지면 시작 표시를 풀고, 모두 동의한 채로 P면 시작한다. */
    private fun settle() = copy(started = agreed && (started || gear == "P"))

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
    fun withTrip(t: Trip) = copy(trip = t, online = true, offPending = offPending && t.people.any { it.consent }).settle()

    fun withGear(g: String?) = copy(gear = g).settle()

    /** 켜기: 서버가 모두의 동의를 저장한 뒤의 여행으로 부른다. 앞서 남은 끄기 대기는 지운다. */
    fun turnedOn(t: Trip) = copy(offPending = false).withTrip(t)

    /** 끄기: 서버 응답을 기다리지 않고 바로 멈춘다. */
    fun turnOff() = copy(offPending = true).settle()

    /** 다음 조회에서 동의 끄기를 다시 보낼 참가자. 끄기 대기일 때만. */
    val offTargets: List<String> get() = if (offPending) trip?.people?.map { it.id }.orEmpty() else emptyList()

    /** 다음 조회에 붙일 version. 끄기 대기면 304로 놓치지 않게 붙이지 않는다. */
    val pollVersion: Int? get() = if (offPending) null else trip?.version

    companion object {
        /** 앱을 다시 켤 때: 저장한 마지막 여행과 두 표시로 되살린다. 연결은 아직 모르는 것으로 둔다. */
        fun restore(tripJson: String?, offPending: Boolean, started: Boolean) =
            Session(trip = tripJson?.let { runCatching { parseTrip(it) }.getOrNull() }, online = false, offPending = offPending, started = started).settle()
    }
}
