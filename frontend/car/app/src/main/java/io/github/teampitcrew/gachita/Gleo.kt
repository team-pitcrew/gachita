package io.github.teampitcrew.gachita

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

// Gleo와 마이크 주고받기(T41, ADR-0008). 호출어 찾기는 화면·SDK와 무관한 규칙(단위 테스트 GleoTest.kt).

/**
 * STT가 "글레오"를 적는 꼴. 11/13 실측에서 6번 중 4번 "클레오"·"클리오"로 적었다.
 * 낱말의 앞에서만 찾는다("클레오야"는 맞고 "스클레오"는 아님). ponytail: 고정 목록. 잘못 알아챈 횟수(Handoff 로그)를 보고 줄이거나 늘린다.
 */
val WAKE_WORDS = listOf("글레오", "클레오", "클리오", "글리오", "그레오", "글래오", "클래오", "gleo")

fun isWake(text: String): Boolean =
    text.lowercase().split(Regex("[^\\p{L}\\p{N}]+")).any { w -> WAKE_WORDS.any { w.startsWith(it) } }

const val WAIT_MS = 15_000L // 넘긴 뒤 운전대 버튼을 기다리는 시간. 지나면 다시 수음하고 잘못 알아챈 것으로 센다
const val GLEO_MS = 60_000L // Gleo가 포커스를 돌려주지 않아도 다시 수음하는 시간. 답을 들은 한 번이 24초였다(11/13)

/**
 * 우리 수음과 Gleo 사이에서 마이크를 넘기고 돌려받는다. 우리 앱이 녹음하는 동안 Gleo는 운전대 버튼을 무시한다(T10).
 * 넘김(호출어나 'Gleo 쓰기'): hold(true)로 AudioRecord만 멈추고(서비스와 STT는 둠) 오디오 포커스를 잠시 쥔다.
 * 운전대 버튼으로 Gleo가 들으면 우리가 포커스를 잃고(LOSS_TRANSIENT), Gleo가 잠들면 돌려받는다(GAIN) → hold(false).
 * Gleo가 다른 앱(음악)에 포커스를 넘기면 우리는 LOSS를 받고 돌려받지 못하므로 그때도 다시 수음한다.
 *
 * 포커스는 이 신호를 받으려고만 쥔다. 시스템 소리 용도(ASSISTANCE_SONIFICATION)와 GAIN_TRANSIENT_MAY_DUCK이라
 * 사용자의 음악은 멈추지 않는다(Pleos 자동차 포커스 규칙에서 미디어와 함께 감, 에뮬레이터 실측은 ADR-0008).
 * 넘긴 동안에만 쥐고, 돌려받으면 바로 놓는다.
 */
class Handoff(ctx: Context, private val hold: (Boolean) -> Unit) {
    enum class State { OFF, WAITING, GLEO }

    var state by mutableStateOf(State.OFF)
        private set
    private val am = ctx.getSystemService(AudioManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private var byWake = false
    private var wakes = 0 // 호출어로 넘긴 수
    private var used = 0 // 그중 Gleo가 실제로 들은 수
    private var missed = 0 // 그중 버튼 없이 시간이 지난 수(잘못 알아챘거나 버튼을 누르지 않음)
    private var since = 0L
    private val timeout = Runnable { back("시간 초과") }

    private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
        .setOnAudioFocusChangeListener(::onFocus, main)
        .build()

    /** 마이크를 Gleo에게 넘긴다(메인 스레드). wake면 호출어로 알아챈 것. 이미 넘겼으면 무시. */
    fun give(wake: Boolean) {
        if (state != State.OFF) return
        byWake = wake
        if (wake) wakes++
        since = System.currentTimeMillis()
        hold(true)
        state = State.WAITING
        val r = am.requestAudioFocus(focus)
        Log.i(TAG, "Gleo에게 넘김 ${if (wake) "호출어" else "단추"} · 포커스 ${if (r == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) "받음" else "못 받음($r)"}")
        main.postDelayed(timeout, WAIT_MS)
    }

    private fun onFocus(change: Int) {
        Log.i(TAG, "포커스 $change · ${state.name}")
        when {
            state == State.WAITING && change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                state = State.GLEO
                if (byWake) used++
                Log.i(TAG, "Gleo 들음 · 넘긴 뒤 ${System.currentTimeMillis() - since}ms")
                main.removeCallbacks(timeout); main.postDelayed(timeout, GLEO_MS)
            }
            state == State.GLEO && change == AudioManager.AUDIOFOCUS_GAIN -> back("Gleo 끝")
            state == State.GLEO && change == AudioManager.AUDIOFOCUS_LOSS -> back("다른 앱이 포커스를 가져감")
        }
    }

    /** 다시 수음한다. */
    private fun back(why: String) {
        if (state == State.OFF) return
        if (state == State.WAITING && byWake) missed++
        stop()
        hold(false)
        Log.i(TAG, "다시 수음($why) · 멈춘 시간 ${System.currentTimeMillis() - since}ms · 호출어 ${wakes}회 중 Gleo ${used}회 · 버튼 없이 시간 초과 ${missed}회")
    }

    /** 수음이 끝나면(동의 끔, 화면 닫힘, 기록 멈추기) 포커스와 시간 재기만 거둔다. 마이크는 서비스가 이미 놓았다. */
    fun stop() {
        main.removeCallbacks(timeout)
        if (state != State.OFF) am.abandonAudioFocusRequest(focus)
        state = State.OFF
    }

    companion object { private const val TAG = "GachitaGleo" }
}
