package io.github.teampitcrew.gachita

const val RECORDING_START_TIMEOUT_MS = 6_000L // Gleo는 7초 뒤 콜백을 취소한다.

/** 동의 조회가 늦게 끝나도 취소·여행 변경·시간 초과 뒤에는 녹음을 시작하지 않는다. */
class RecordingStartAttempt(private val code: String, private val generation: Int, private val since: Long) {
    private var finished = false

    fun accepts(trip: Trip?, now: Long): Boolean = !finished && now - since in 0 until RECORDING_START_TIMEOUT_MS &&
        trip?.code == code && trip.generation == generation

    fun finish(): Boolean {
        if (finished) return false
        finished = true
        return true
    }
}
