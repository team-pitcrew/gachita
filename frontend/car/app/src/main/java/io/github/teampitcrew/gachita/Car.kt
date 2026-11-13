package io.github.teampitcrew.gachita

import ai.pleos.playground.navi.constants.NaviErrorCode
import ai.pleos.playground.navi.constants.WaypointCmdType
import ai.pleos.playground.navi.constants.WaypointIndex
import ai.pleos.playground.navi.data.CurrentLocationInfo
import ai.pleos.playground.navi.data.DestinationInfo
import ai.pleos.playground.navi.data.RequestWaypointInfo
import ai.pleos.playground.navi.data.RouteInfo
import ai.pleos.playground.navi.data.RouteStartInfo
import ai.pleos.playground.navi.data.RouteWithWaypointsRequest
import ai.pleos.playground.navi.data.TripInfo
import ai.pleos.playground.navi.data.TripRequest
import ai.pleos.playground.navi.data.WaypointChangedInfo
import ai.pleos.playground.navi.data.WaypointInfo
import ai.pleos.playground.navi.helper.NaviHelper
import ai.pleos.playground.navi.helper.listener.NaviHelperEventListener
import ai.pleos.playground.tts.TextToSpeech
import ai.pleos.playground.tts.constant.ErrorType
import ai.pleos.playground.tts.constant.Mode
import ai.pleos.playground.tts.listener.EventListener
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
 * restricted는 플랫폼이 주행 제한을 거는 중인지(CarUxRestrictions. 기어 D여도 오토 홀드면 풀릴 수 있음). 값을 받기 전이나 받지 못하면 제한으로 둔다(frontend/spec/car.md).
 */
data class CarStatus(val gear: String? = null, val navi: Boolean = false, val voice: Boolean = false, val naviEvent: String = "", val restricted: Boolean = true)

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
    @Volatile private var ttsFrom = 0L // 우리 TTS가 말한 구간(epoch ms). 말하는 중이면 ttsTo = Long.MAX_VALUE
    @Volatile private var ttsTo = 0L

    private fun update(f: (CarStatus) -> CarStatus) { main.post { status = f(status); onChange(status) } }

    private val gearListener = object : GearSelectionListener {
        override fun onSelected(gear: VehicleGear?) { update { it.copy(gear = label(gear)) } }
        override fun onFailed(e: Exception) { Log.w(TAG, "기어 알림 실패", e); update { it.copy(gear = null) } }
    }

    /**
     * 내비에 묻고 답 알림을 한 번 기다린다(메인 스레드). ms 안에 오지 않으면 null. 같은 물음이 겹치면 앞의 것은 null로 끝낸다.
     * NaviHelper는 물음의 답을 리스너 알림으로 돌려준다(경유지 추가는 약 6초 뒤 onWaypointChanged, 11/12).
     */
    private inner class Wait<T>(private val ms: Long) {
        private var done: ((T?) -> Unit)? = null
        private var n = 0

        fun start(done: (T?) -> Unit, call: () -> Unit) {
            answer(null)
            if (!status.navi) return done(null)
            this.done = done
            val my = ++n
            main.postDelayed({ if (n == my) answer(null) }, ms)
            runCatching(call).onFailure { Log.w(TAG, "내비 호출 실패", it); answer(null) }
        }

        fun answer(v: T?) { val d = done ?: return; done = null; d(v) }
    }

    private val here = Wait<CurrentLocationInfo>(2_000)
    private val trip = Wait<TripInfo>(3_000)
    private val stop = Wait<Boolean>(30_000) // onWaypointChanged까지 11/13 7.6초, 11/13 밤 9.9~12.9초
    private val dest = Wait<DestinationInfo>(2_000)
    private val wps = Wait<List<WaypointInfo>>(2_000)

    private val naviListener = object : NaviHelperEventListener {
        override fun onRouteStarted(routeStartInfo: RouteStartInfo) = naviEvent("경로 시작 ${routeStartInfo.name ?: ""}")
        override fun onWaypointChanged(waypointChangedInfo: WaypointChangedInfo) {
            naviEvent("경유지 ${waypointChangedInfo.cmdType} ${waypointChangedInfo.routeStartInfo?.name ?: ""}")
            if (waypointChangedInfo.cmdType == WaypointCmdType.ADD) main.post { stop.answer(true) }
        }
        override fun onRouteCancelled() = naviEvent("안내 취소") // 경유지를 더하면 안내가 한 번 끊겼다 다시 시작한다(11/13). 실패로 보지 않는다
        override fun onError(errorCode: NaviErrorCode) {
            naviEvent("내비 오류 ${errorCode.name}")
            main.post { if (errorCode == NaviErrorCode.CAUSE_SEARCH_TRIP) trip.answer(null) else stop.answer(false) } // 거리 묻기의 오류는 경유지 실패가 아니다
        }
        override fun onCurrentLocationInfo(currentLocationInfo: CurrentLocationInfo) { main.post { here.answer(currentLocationInfo) } }
        override fun onTripInfo(tripInfo: TripInfo) { main.post { trip.answer(tripInfo) } }
        override fun onDestinationInfo(destinationInfo: DestinationInfo) { main.post { dest.answer(destinationInfo) } }
        override fun onWayPointInfo(waypointInfo: List<WaypointInfo>) { main.post { wps.answer(waypointInfo) } }
    }

    /**
     * 주행 제한(T11). Pleos 가이드대로 기어·속도로 직접 판단하지 않고 플랫폼 값만 따른다(북미 밖: 5 km/h 이하이고 P·주차 브레이크·오토 홀드면 풀림).
     * ponytail: 제한 비트(NO_SETUP 64, NO_VIDEO 16 …)를 따로 보지 않고 '제한 중' 하나로 주행 화면을 그린다. 영상·키보드처럼 비트마다 다른 화면이 생기면 비트를 넘긴다.
     */
    private val uxListener = CarUxRestrictionsManager.OnUxRestrictionsChangedListener(::onUx)

    private fun onUx(r: CarUxRestrictions?) {
        val on = r?.isRequiresDistractionOptimization ?: true
        Log.i(TAG, "주행 제한 ${if (on) "켜짐" else "꺼짐"} ${r?.activeRestrictions}")
        update { it.copy(restricted = on) }
    }

    private fun naviEvent(e: String) { Log.i(TAG, "내비: $e"); update { it.copy(naviEvent = e) } }

    fun start() {
        runCatching {
            vehicle = Vehicle(app).also { it.initialize(); it.getGear().registerGearSelection(gearListener) }
        }.onFailure { Log.w(TAG, "Vehicle 초기화 실패", it) }
        readGear { }
        // 차 서비스가 늦게 뜨거나 다시 뜨면 ready로 다시 불린다. 생명주기 리스너 없이 만들면 차 서비스가 죽을 때 우리 프로세스도 같이 죽는다(AOSP Car)
        runCatching {
            aaos = android.car.Car.createCar(app, main, android.car.Car.CAR_WAIT_TIMEOUT_DO_NOT_WAIT) { c, ready ->
                ux = null
                if (!ready) return@createCar onUx(null)
                runCatching {
                    ux = (c.getCarManager(android.car.Car.CAR_UX_RESTRICTION_SERVICE) as CarUxRestrictionsManager).also {
                        it.registerListener(uxListener)
                        onUx(it.currentCarUxRestrictions)
                    }
                }.onFailure { Log.w(TAG, "주행 제한 값을 받지 못함 · 제한된 화면으로 둠", it) }
            }
        }.onFailure { Log.w(TAG, "차 서비스에 붙지 못함 · 제한된 화면으로 둠", it) }
        runCatching {
            navi.initialize(
                onConnected = { navi.addListener(naviListener); update { it.copy(navi = true) } },
                onFailed = { t -> Log.w(TAG, "내비 서비스에 붙지 못함", t) },
            )
        }.onFailure { Log.w(TAG, "NaviHelper 초기화 실패", it) }
        runCatching {
            tts = TextToSpeech(app, Mode.ON_DEVICE).also { t ->
                t.initialize(object : OnInitializeListener {
                    override fun onSuccess() { t.setLocale(Locale.KOREA); t.addEventListener(ttsListener); update { it.copy(voice = true) } }
                    override fun onFailure(error: ErrorType) { Log.w(TAG, "TTS 초기화 실패 ${error.name}") }
                })
            }
        }.onFailure { Log.w(TAG, "TTS 만들기 실패", it) }
    }

    fun stop() {
        runCatching { vehicle?.getGear()?.unregisterGearSelection(gearListener) }
        runCatching { vehicle?.release() }
        runCatching { ux?.unregisterListener() }
        runCatching { aaos?.disconnect() }
        main.removeCallbacksAndMessages(null) // 기다리던 내비 답과 시간 초과를 버린다(화면이 없어진 뒤 불리지 않게)
        runCatching { navi.removeListener(naviListener); navi.release() }
        runCatching { tts?.release() }
    }

    /** 기어를 지금 다시 읽는다. 읽지 못하면 null. 기록 동의를 켜기 직전에 이 값으로 판단한다. */
    fun readGear(done: (String?) -> Unit) {
        val v = vehicle ?: return done(null)
        fun answer(g: String?) { main.post { status = status.copy(gear = g); onChange(status); done(g) } }
        runCatching { v.getGear().getCurrentGearSelectionState({ answer(label(it)) }, { answer(null) }) }.onFailure { answer(null) }
    }

    fun speak(text: String) {
        Log.i(TAG, "말함 ${text.length}자" + if (status.voice) "" else " · TTS 준비 안 됨") // 글자는 남기지 않는다(받아 적은 말이 들어갈 수 있음)
        if (!status.voice) return
        ttsFrom = System.currentTimeMillis(); ttsTo = Long.MAX_VALUE // 첫 소리는 0.3~0.4초 뒤(11/2). 부른 때부터 센다
        runCatching { tts?.speak(text, true) }.onFailure { ttsTo = System.currentTimeMillis() }
    }

    private val ttsListener = object : EventListener {
        override fun onDone() { ttsTo = System.currentTimeMillis() }
        override fun onStop() { ttsTo = System.currentTimeMillis() }
        override fun onError(error: ai.pleos.playground.tts.constant.ErrorType) { ttsTo = System.currentTimeMillis() }
        override fun onStart() {}
        override fun onReady() {}
        override fun onUpdatedRms(rms: Double) {}
    }

    /** 받아 적은 말이 우리 TTS 소리일 수 있는지: 첫 중간 결과가 우리가 말하는 동안(끝난 뒤 0.3초까지) 왔다. */
    fun ownVoice(firstPartialAt: Long) = overlapsSpeech(firstPartialAt, ttsFrom, ttsTo)

    /** 내비가 아는 지금 위치. 화면은 넘어가지 않는다(0.1~0.2초, 11/12). 모르면 null, null. */
    fun here(done: (Double?, Double?) -> Unit) = here.start({ done(it?.latitude, it?.longitude) }) { navi.getCurrentLocationInfo() }

    /** 그곳까지의 거리(m)와 시간(초). 들르면 늘어나는 시간이 아니다. 화면은 넘어가지 않는다. */
    fun distanceTo(p: Place, done: (Int?, Int?) -> Unit) =
        trip.start({ done(it?.distance, it?.eta) }) { navi.requestTrip(TripRequest(latitude = p.lat, longitude = p.lng, poiId = "", poiName = p.name, poiSubId = "0")) }

    /**
     * 내비가 지금 향하는 다음 곳의 이름: 첫 경유지, 없으면 목적지(T40 도착 판정). 모르면 null. 화면은 넘어가지 않는다.
     * 에뮬레이터는 경유지 좌표를 0.0으로 주어 이름만 쓴다. 지난 경유지는 내비가 목록에서 뺀다고 보고 있다(실차 확인 전).
     */
    fun nextStopName(done: (String?) -> Unit) = wps.start({ w ->
        w?.map { it.name }?.firstOrNull { !it.isNullOrBlank() }?.let { return@start done(it) }
        dest.start({ d -> done(d?.name?.takeIf { it.isNotBlank() }) }) { navi.getDestinationInfo() }
    }) { navi.getWaypointInfo() }

    /** 지금 경로에 들를 곳을 더한다. 내비가 앞으로 나오고, 반영 알림(onWaypointChanged ADD)이 오면 true. 경로 오류나 30초 넘으면 false. */
    fun addStop(p: Place, done: (Boolean) -> Unit) = stop.start({ done(it == true) }) {
        navi.addWaypoint(RequestWaypointInfo(latitude = p.lat, longitude = p.lng, poiName = p.name, waypointIndex = WaypointIndex.FIRST, poiId = "", address = p.address, poiSubId = "0"))
    }

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
