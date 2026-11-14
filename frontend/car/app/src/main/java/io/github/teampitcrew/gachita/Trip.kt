package io.github.teampitcrew.gachita

import org.json.JSONObject

/** Pleos Vehicle SDK의 SeatArea 이름(API의 Seat). */
enum class Seat(val label: String) {
    ROW_1_LEFT("운전석"), ROW_1_RIGHT("조수석"), ROW_2_LEFT("뒷자리 왼쪽"), ROW_2_CENTER("뒷자리 가운데"), ROW_2_RIGHT("뒷자리 오른쪽")
}

/**
 * 좌석 지도의 줄(앞줄, 뒷줄 …). 칸은 차가 알려 준 좌석 영역(CarStatus.seats, T83)에서 만든다. 서버가 받는 자리(Seat)만 그리고,
 * 차가 좌석을 알려 주지 않으면 기본 배치(앞 둘·뒤 셋)를 쓴다. 한 줄 안은 왼쪽 → 가운데 → 오른쪽.
 * ponytail: 3열 좌석(ROW_3_*)은 서버의 자리 값에 없어 그리지 않는다. 3열 차가 생기면 Seat와 서버 SEATS에 함께 더한다.
 */
fun seatRows(carSeats: List<String>): List<List<Seat>> {
    val known = Seat.entries.filter { carSeats.isEmpty() || it.name in carSeats }
    val side = listOf("LEFT", "CENTER", "RIGHT")
    return known.groupBy { it.name.substringBeforeLast('_') }.toSortedMap().values.map { row -> row.sortedBy { side.indexOf(it.name.substringAfterLast('_')) } }
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

/** profile은 프로필로 참가한 사람(그 프로필의 목소리 등록값이 대조 후보가 됨, #65). */
data class Person(val id: String, val name: String, val seat: String, val consent: Boolean, val profile: Boolean = false)

/** generation은 동의 세대(동의 철회로 올라감), createdAt은 만든 시각(epoch ms). */
data class Trip(
    val code: String, val title: String, val status: String, val people: List<Person>, val heldRequests: Int, val version: Int,
    val generation: Int = 1, val createdAt: Long = 0, val moments: List<Moment> = emptyList(),
)

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
            ps.getJSONObject(i).let { Person(it.getString("id"), it.getString("name"), it.getString("seat"), it.getBoolean("consent"), !it.isNull("profileId")) }
        },
        heldRequests = (0 until rs.length()).count { rs.getJSONObject(it).getString("status") == "held" },
        version = o.getInt("version"),
        generation = o.optInt("generation", 1),
        createdAt = o.getLong("createdAt"),
        moments = o.optJSONArray("moments")?.let { a ->
            List(a.length()) { i -> a.getJSONObject(i).let { Moment(it.getString("id"), it.getLong("at"), it.optLongOrNull("from"), it.optLongOrNull("to")) } }
        }.orEmpty(),
    )
}

private fun JSONObject.optLongOrNull(k: String) = if (has(k) && !isNull(k)) getLong(k) else null

/**
 * 차량 앱이 보는 여행 하나의 상태. 화면은 이 값만 보고 그린다.
 *
 * 기록 동의 규칙(T7, T68):
 * - 기본값은 꺼짐. 참가자는 동의 꺼짐으로 만든다.
 * - 켜기는 기어 P이고 서버에 닿을 때만. 차가 켜는 것은 이 차가 참가시킨 사람(ours, 참가자 토큰을 가진 사람)의 동의뿐이다.
 *   폰으로 들어온 사람은 자기 폰에서 켠다. 차에서도 각 사람이 자기 동의만 확인한다.
 * - 모두 동의해도 녹음은 시작하지 않는다. 주차(P) 중 명시적으로 시작한 뒤(started)에만 주행 중에도 이어 간다.
 * - 동의 철회나 세대 변경은 시작 표시도 취소한다. 다시 동의해도 시작 버튼을 눌러야 한다.
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
    val ours: Set<String> = emptySet(),
    val withdrawn: Set<String> = emptySet(), // 철회 전송 대기. 비어 있는 offPending은 이전 판의 전원 철회와 호환한다.
    val pollNote: String = "", // 여행 조회 실패로 note에 적은 문구. 다음 조회가 성공하면 이것만 지운다(T122)
) {
    val consented: Boolean get() = trip != null && trip.people.isNotEmpty() && trip.people.all { it.consent }

    /**
     * 동의 스위치에 보일 값: 모두 동의했거나, 이 차가 참가시킨 사람이 모두 동의했고 끄기 대기가 없음.
     * 폰 참가자를 기다리는 동안에도 켜짐으로 보여 끌 수 있고, 토큰을 잃었어도(앞 빌드에서 올림) 기록 중이면 끌 수 있다.
     */
    val switchOn: Boolean get() = agreed || !offPending && trip != null && trip.people.filter { it.id in ours }.let { it.isNotEmpty() && it.all { p -> p.consent } }

    /** 자기 폰에서 동의를 켜야 하는 사람(차가 켤 수 없음). */
    fun waitsFor(p: Person) = !p.consent && p.id !in ours

    /** 동의 스위치에 보일 값: 모두 동의했고 끄기 대기가 없음. */
    val agreed: Boolean get() = consented && !offPending
    val recording: Boolean get() = agreed && started

    /** 모두 동의했고 사용자의 명시적인 녹음 시작을 기다리는 상태. */
    val waiting: Boolean get() = agreed && !started

    private fun settle() = copy(started = agreed && started)

    fun blockStart(): String? = when {
        busy -> "처리하고 있어요"
        !agreed -> "탑승자 모두의 녹음 동의가 필요해요"
        trip?.status == "ended" -> "끝난 여행이에요. 새 여행에서 녹음을 시작해 주세요"
        !online -> "연결을 확인한 뒤 녹음을 시작해 주세요"
        gear != "P" -> "주차(P)한 뒤 녹음을 시작할 수 있어요"
        else -> null
    }

    fun startRecording(): Session = if (blockStart() == null) copy(started = true, note = "") else this

    /** 동의를 켤 수 없으면 그 이유. 켤 수 있으면 null. */
    fun blockOn(): String? = when {
        trip == null -> "여행이 없어요"
        busy -> "처리하고 있어요"
        trip.people.none { it.id in ours } -> "이 차에서 참가시킨 사람이 없어 켤 수 없어요"
        offPending -> "동의 철회를 서버에 알리고 있어요"
        !online -> "연결을 확인한 뒤 동의할 수 있어요"
        gear == null -> "기어를 확인할 수 없어 동의를 켤 수 없어요"
        gear != "P" -> "주차(P)한 뒤에 켤 수 있어요"
        else -> null
    }

    /**
     * 여행 조회가 실패했다(T122). 서버가 답했으면(거절·잠깐 못 받음) 그 이유를 적고, 닿지 않았으면 연결 끊김으로만 보이고 문구는 그대로 둔다.
     * ponytail: 502·503·504도 전처럼 연결된 것으로 센다. 연결 대기로 세면 쇼츠 화면이 보던 영상을 비우는 등 다른 화면도 함께 바뀐다(T122 리뷰).
     */
    fun pollFailed(e: Throwable): Session {
        if (e !is ApiError) return copy(online = false)
        val why = failureText(e) + if (e.transient) ". 다시 시도할게요" else ""
        return copy(online = true, note = why, pollNote = why)
    }

    /**
     * 본인 동의 켜기가 실패했다. 잠깐 못 받은 응답이면 동의 PATCH가 닿았는지 모르니 '확인하지 못했어요'로 적고, 다음 조회가 실제 동의를
     * 보이면서 그 문구를 지우게 한다(T122). 거절과 통신 실패는 저장하지 못한 것이라 사용자가 다시 누를 때까지 남긴다.
     */
    fun agreeFailed(e: Throwable): Session {
        val unsure = e is ApiError && e.transient
        val why = (if (unsure) "동의 저장을 확인하지 못했어요 · " else "동의를 저장하지 못했어요 · ") + failureText(e)
        return copy(busy = false, online = e is ApiError, note = why, pollNote = if (unsure) why else pollNote)
    }

    /** 여행 조회가 성공했다. 지난 조회 실패 문구만 지우고, 그사이 사용자가 한 일의 결과 문구(동의 저장 등)는 둔다. */
    fun polled() = if (pollNote.isEmpty()) this else copy(note = if (note == pollNote) "" else note, pollNote = "")

    /** 서버에서 받은 최신 여행을 반영한다. 서버도 모두 꺼짐이면 끄기 대기를 푼다. */
    fun withTrip(t: Trip): Session {
        val pending = offPending && t.people.any { it.consent && (withdrawn.isEmpty() || it.id in withdrawn) }
        return copy(trip = t, online = true, offPending = pending, withdrawn = if (pending) withdrawn else emptySet(),
            started = started && trip?.generation == t.generation && t.status != "ended").settle() // 끝난 여행은 녹음하지 않는다(기록·동의는 그대로)
    }

    fun withGear(g: String?) = copy(gear = g).settle()

    /** 켜기: 서버가 모두의 동의를 저장한 뒤의 여행으로 부른다. 앞서 남은 끄기 대기는 지운다. */
    fun turnedOn(t: Trip) = withTrip(t)

    /** 끄기: 서버 응답을 기다리지 않고 바로 멈춘다. */
    fun turnOff(id: String? = null) = copy(offPending = true,
        withdrawn = if (id == null || offPending && withdrawn.isEmpty()) emptySet() else withdrawn + id).settle()

    /** 다음 조회에서 동의 끄기를 다시 보낼 참가자. 끄기 대기일 때만. */
    val offTargets: List<String> get() = if (offPending) trip?.people?.map { it.id }?.filter { withdrawn.isEmpty() || it in withdrawn }.orEmpty() else emptyList()

    /** 다음 조회에 붙일 version. 끄기 대기면 304로 놓치지 않게 붙이지 않는다. */
    val pollVersion: Int? get() = if (offPending) null else trip?.version

    companion object {
        /** 앱을 다시 켤 때: 저장한 마지막 여행과 두 표시로 되살린다. 연결은 아직 모르는 것으로 둔다. */
        fun restore(tripJson: String?, offPending: Boolean, started: Boolean, ours: Set<String> = emptySet(), withdrawn: Set<String> = emptySet()) =
            Session(trip = tripJson?.let { runCatching { parseTrip(it) }.getOrNull() }, online = false, offPending = offPending, started = started, ours = ours, withdrawn = withdrawn).settle()
    }
}
