package io.github.teampitcrew.gachita

import ai.pleos.playground.navi.constants.NaviErrorCode
import ai.pleos.playground.navi.constants.WaypointIndex
import ai.pleos.playground.navi.data.RequestWaypointInfo
import ai.pleos.playground.navi.data.RouteInfo
import ai.pleos.playground.navi.data.RouteStartInfo
import ai.pleos.playground.navi.data.RouteWithWaypointsRequest
import ai.pleos.playground.navi.data.WaypointChangedInfo
import ai.pleos.playground.navi.helper.NaviHelper
import ai.pleos.playground.navi.helper.listener.NaviHelperEventListener
import ai.pleos.playground.tts.TextToSpeech
import ai.pleos.playground.tts.constant.ErrorType
import ai.pleos.playground.tts.constant.Mode
import ai.pleos.playground.tts.listener.OnInitializeListener
import ai.pleos.playground.vehicle.Vehicle
import ai.pleos.playground.vehicle.api.model.area.SeatArea
import ai.pleos.playground.vehicle.constant.area.SeatValue
import ai.pleos.playground.vehicle.constant.control.VehicleGear
import ai.pleos.playground.vehicle.constant.unit.TemperatureUnit
import ai.pleos.playground.vehicle.listener.GearSelectionListener
import android.car.drivingstate.CarUxRestrictions
import android.car.drivingstate.CarUxRestrictionsManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.Locale

/**
 * 차가 알려 준 것. gear는 "P", "D", "R", "N" 같은 글자이고 모르면 null.
 * driving은 플랫폼이 주행 제한을 거는 중인지(CarUxRestrictions). 값을 받기 전이나 받지 못하면 제한으로 둔다(frontend/spec/car.md).
 */
data class CarStatus(val gear: String? = null, val navi: Boolean = false, val voice: Boolean = false, val naviEvent: String = "", val driving: Boolean = true)

data class Place(val lat: Double, val lng: Double, val name: String, val address: String = "")

/**
 * Pleos Connect SDK를 감싼다: Vehicle(기어 · 공조), NaviHelper(순정 내비), TextToSpeech. 주행 제한 값은 AAOS CarUxRestrictionsManager에서 받는다.
 * 차박지도 앱(chabak-map/car, 11/10)의 Car.kt에서 옮겼다. 콜백은 모두 메인 스레드로 넘긴다.
 */
class Car(ctx: Context, private val onChange: (CarStatus) -> Unit) {
    private val app = ctx.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val navi = NaviHelper(app)
    private var vehicle: Vehicle? = null
    private var tts: TextToSpeech? = null
    private var aaos: android.car.Car? = null
    private var ux: CarUxRestrictionsManager? = null
    private var status = CarStatus()
    private var savedTemp: Float? = null

    private fun update(f: (CarStatus) -> CarStatus) { main.post { status = f(status); onChange(status) } }

    private val gearListener = object : GearSelectionListener {
        override fun onSelected(gear: VehicleGear?) { update { it.copy(gear = label(gear)) } }
        override fun onFailed(e: Exception) { Log.w(TAG, "기어 알림 실패", e); update { it.copy(gear = null) } }
    }

    private val naviListener = object : NaviHelperEventListener {
        override fun onRouteStarted(routeStartInfo: RouteStartInfo) = naviEvent("경로 시작 ${routeStartInfo.name ?: ""}")
        override fun onWaypointChanged(waypointChangedInfo: WaypointChangedInfo) = naviEvent("경유지 바뀜") // T9가 이 알림을 보고 '경유 반영'으로 바꾼다
        override fun onRouteCancelled() = naviEvent("안내 취소")
        override fun onError(errorCode: NaviErrorCode) = naviEvent("내비 오류 ${errorCode.name}")
    }

    /**
     * 주행 제한(T11). Pleos 가이드대로 기어·속도로 직접 판단하지 않고 플랫폼 값만 따른다(북미 밖: 5 km/h 이하이고 P·주차 브레이크·오토 홀드면 풀림).
     * ponytail: 제한 비트(NO_SETUP 64, NO_VIDEO 16 …)를 따로 보지 않고 '제한 중' 하나로 주행 화면을 그린다. 영상·키보드처럼 비트마다 다른 화면이 생기면 비트를 넘긴다.
     */
    private val uxListener = CarUxRestrictionsManager.OnUxRestrictionsChangedListener(::onUx)

    private fun onUx(r: CarUxRestrictions?) {
        val driving = r?.isRequiresDistractionOptimization ?: true
        Log.i(TAG, "주행 제한 ${if (driving) "켜짐" else "꺼짐"} ${r?.activeRestrictions}")
        update { it.copy(driving = driving) }
    }

    private fun naviEvent(e: String) { Log.i(TAG, "내비: $e"); update { it.copy(naviEvent = e) } }

    fun start() {
        runCatching {
            vehicle = Vehicle(app).also { it.initialize(); it.getGear().registerGearSelection(gearListener) }
        }.onFailure { Log.w(TAG, "Vehicle 초기화 실패", it) }
        readGear { }
        runCatching {
            aaos = android.car.Car.createCar(app)?.also { c ->
                ux = (c.getCarManager(android.car.Car.CAR_UX_RESTRICTION_SERVICE) as CarUxRestrictionsManager).also {
                    it.registerListener(uxListener)
                    onUx(it.currentCarUxRestrictions)
                }
            }
        }.onFailure { Log.w(TAG, "주행 제한 값을 받지 못함 · 제한된 화면으로 둠", it) }
        runCatching {
            navi.initialize(
                onConnected = { navi.addListener(naviListener); update { it.copy(navi = true) } },
                onFailed = { t -> Log.w(TAG, "내비 서비스에 붙지 못함", t) },
            )
        }.onFailure { Log.w(TAG, "NaviHelper 초기화 실패", it) }
        runCatching {
            tts = TextToSpeech(app, Mode.ON_DEVICE).also { t ->
                t.initialize(object : OnInitializeListener {
                    override fun onSuccess() { t.setLocale(Locale.KOREA); update { it.copy(voice = true) } }
                    override fun onFailure(error: ErrorType) { Log.w(TAG, "TTS 초기화 실패 ${error.name}") }
                })
            }
        }.onFailure { Log.w(TAG, "TTS 만들기 실패", it) }
    }

    fun stop() {
        runCatching { vehicle?.getGear()?.unregisterGearSelection(gearListener) }
        runCatching { vehicle?.release() }
        runCatching { ux?.unregisterListener(); aaos?.disconnect() }
        runCatching { navi.removeListener(naviListener); navi.release() }
        runCatching { tts?.release() }
    }

    /** 기어를 지금 다시 읽는다. 읽지 못하면 null. 기록 동의를 켜기 직전에 이 값으로 판단한다. */
    fun readGear(done: (String?) -> Unit) {
        val v = vehicle ?: return done(null)
        fun answer(g: String?) { main.post { status = status.copy(gear = g); onChange(status); done(g) } }
        runCatching { v.getGear().getCurrentGearSelectionState({ answer(label(it)) }, { answer(null) }) }.onFailure { answer(null) }
    }

    fun speak(text: String) { if (status.voice) runCatching { tts?.speak(text, true) } }

    /** 순정 내비에 목적지와 들를 곳(둘까지)을 보낸다. 반영은 onWaypointChanged로 온다(T9). */
    fun route(dest: Place, stops: List<Place>): Boolean {
        if (!status.navi) return false
        val to = RouteInfo(latitude = dest.lat, longitude = dest.lng, poiName = dest.name, poiId = "", address = dest.address, poiSubId = "0")
        return runCatching {
            if (stops.isEmpty()) navi.requestRoute(to)
            else {
                val idx = listOf(WaypointIndex.FIRST, WaypointIndex.SECOND)
                val wps = stops.take(2).mapIndexed { i, s ->
                    RequestWaypointInfo(latitude = s.lat, longitude = s.lng, poiName = s.name, waypointIndex = idx[i], poiId = "", address = s.address, poiSubId = "0")
                }
                navi.requestRouteWithWaypoints(RouteWithWaypointsRequest(destination = to, waypoints = wps))
            }
        }.onFailure { Log.w(TAG, "경로 요청 실패", it) }.isSuccess
    }

    // ponytail: 공조는 옮겨만 두고 이 티켓에서는 부르지 않는다(T8). 적용 → 다시 읽어 확인 → 끝낼 때 처음 값으로 복원.
    private val driver = SeatArea(SeatValue.ROW_1_LEFT)

    /** 운전석 온도를 바꾸고 0.7초 뒤 다시 읽어 맞으면 true. 처음 값은 restoreTemp가 되돌린다. */
    fun applyTemp(tempC: Float, done: (Boolean, String) -> Unit) {
        val hvac = vehicle?.getHVAC() ?: return done(false, "Vehicle SDK에 붙지 못했어요")
        fun say(ok: Boolean, m: String) = main.post { done(ok, m) }
        hvac.getHvacTemperature(driver, TemperatureUnit.CELSIUS, { before ->
            if (savedTemp == null) savedTemp = before
            hvac.setHvacTemperature(driver, tempC, TemperatureUnit.CELSIUS, { _, _ ->
                main.postDelayed({
                    hvac.getHvacTemperature(driver, TemperatureUnit.CELSIUS, { after -> say(after == tempC, "$before℃ → 다시 읽은 값 $after℃") }, { e -> say(false, "다시 읽지 못함: ${e.message}") })
                }, 700)
            }, { e -> say(false, "적용 실패: ${e.message}") })
        }, { e -> say(false, "읽지 못함: ${e.message}") })
    }

    fun restoreTemp(done: (Boolean, String) -> Unit) {
        val t = savedTemp ?: return done(true, "바꾼 값이 없어요")
        applyTemp(t) { ok, m -> if (ok) savedTemp = null; done(ok, m) }
    }

    companion object {
        private const val TAG = "GachitaCar"
        fun label(g: VehicleGear?): String? = when (g) {
            null, VehicleGear.GEAR_UNKNOWN -> null
            VehicleGear.GEAR_PARK -> "P"
            VehicleGear.GEAR_DRIVE -> "D"
            VehicleGear.GEAR_REVERSE -> "R"
            VehicleGear.GEAR_NEUTRAL -> "N"
            else -> g.name.removePrefix("GEAR_")
        }
    }
}
