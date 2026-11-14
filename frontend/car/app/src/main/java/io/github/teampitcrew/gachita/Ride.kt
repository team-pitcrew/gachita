package io.github.teampitcrew.gachita

import java.net.URI

/** 아무도 앉지 않은 자리(앞줄부터). */
fun freeSeats(t: Trip, carSeats: List<String> = emptyList()): List<Seat> =
    seatRows(carSeats).flatten().filter { s -> t.people.none { it.seat == s.name } }

internal data class BoardingInvite(val id: String, val url: String, val expiresAt: Long) {
    fun secondsLeft(now: Long): Long = ((expiresAt - now + 999) / 1000).coerceAtLeast(0)
}

/** 참가자 토큰 대신 서버가 만든 짧은 초대 URL만 QR로 표시합니다. 다른 출처와 추가 매개변수는 거절합니다. */
internal fun boardingInviteUrl(apiBase: String, path: String): String {
    val base = URI(apiBase.trim().trimEnd('/') + "/")
    val url = base.resolve(path)
    require(base.scheme in setOf("https", "http") && base.host != null)
    require(url.scheme == base.scheme && url.host == base.host && url.port == base.port && url.rawUserInfo == null)
    require(url.path == "/" && url.fragment == null && Regex("join=[A-Za-z0-9_-]{20,256}").matches(url.rawQuery.orEmpty()))
    return url.toASCIIString()
}

/** 발급 중 화면·여행·서버·운전자·주차가 바뀐 결과는 표시하지 않고 폐기합니다. */
internal data class BoardingInviteAttempt(val request: Int, val trip: String, val server: String, val driver: String) {
    fun accepts(currentRequest: Int, currentTrip: Trip?, currentServer: String, ours: Set<String>, parked: Boolean, visible: Boolean): Boolean =
        request == currentRequest && currentTrip?.code == trip && server == currentServer && visible && parked &&
            currentTrip.status in setOf("boarding", "parked") && currentTrip.people.any { it.id == driver && it.seat == Seat.ROW_1_LEFT.name && it.id in ours }
}

/** 닫기가 발급보다 먼저 끝나도 원격 초대를 남기지 않도록 소유권을 한 번만 넘깁니다. */
internal class BoardingInviteCall {
    private var cancelled = false
    private var value: BoardingInvite? = null
    @Synchronized fun issued(invite: BoardingInvite): Boolean {
        if (cancelled) return false
        value = invite
        return true
    }
    @Synchronized fun cancel(): BoardingInvite? {
        cancelled = true
        return value.also { value = null }
    }
}
