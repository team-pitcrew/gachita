package io.github.teampitcrew.gachita

import android.Manifest
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors

// 색은 frontend/web/style.css의 토큰과 같다. 꾸밈은 시안(T20) 뒤에 맞춘다.
private val LightColors = lightColorScheme(
    background = Color(0xFFF6F5F9), surface = Color(0xFFFFFFFF), onBackground = Color(0xFF1F1D2B), onSurface = Color(0xFF1F1D2B),
    onSurfaceVariant = Color(0xFF5A5669), outline = Color(0xFFE4E1EB), primary = Color(0xFF5B47B0), primaryContainer = Color(0xFFEFEBFA),
    onPrimary = Color(0xFFFFFFFF), error = Color(0xFFB3261E), tertiary = Color(0xFF1B7350),
)
private val DarkColors = darkColorScheme(
    background = Color(0xFF17161F), surface = Color(0xFF22202D), onBackground = Color(0xFFECE9F3), onSurface = Color(0xFFECE9F3),
    onSurfaceVariant = Color(0xFFAAA5BA), outline = Color(0xFF383549), primary = Color(0xFFB6A6EE), primaryContainer = Color(0xFF2F2A47),
    onPrimary = Color(0xFF17161F), error = Color(0xFFFF9288), tertiary = Color(0xFF74D3A8),
)

// 칩·단추(labelLarge)와 입력란(bodyLarge)의 기본 14~16sp는 차 화면에서 작다
private val CarType = Typography(labelLarge = TextStyle(fontSize = 24.sp), bodyLarge = TextStyle(fontSize = 24.sp))

private const val DEFAULT_SERVER = "https://gachita.mangowhois.ai" // 실서비스(T27). 로컬 서버는 디버그 빌드에서 '서버 주소'나 --es server로
private const val POLL_MS = 10_000L // 웹앱은 2초. 차에서는 주행 중 자원 기준(CPU 5% 미만)을 생각해 길게 둔다
private const val TITLE = "가치타 가족 여행"
private const val TAG = "GachitaAsk"
private const val RESULT_MS = 60_000L // 경유지 결과 카드를 보여 두는 시간
private const val GLEO_ARRIVAL = "GACHITA_ARRIVAL_TASKS" // assets/schema.json의 함수 이름(T40)
private const val GLEO_PAUSE = "GACHITA_PAUSE_RECORDING" // 같은 곳(T41)
private const val GLEO_RESUME = "GACHITA_RESUME_RECORDING"
private const val OFFER_MS = 30_000L // 제안에 답이 없으면 보관으로 되돌리는 시간. 그사이 휴게소를 지나칠 수 있어 길게 두지 않는다

class MainActivity : ComponentActivity() {
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var prefs: SharedPreferences
    private lateinit var car: Car

    private var state by mutableStateOf(Session())

    /**
     * 화면 상태. 끄기 대기와 주차 중 시작 표시는 앱이 다시 켜져도 이어지게 바뀔 때마다 저장한다.
     * commit(): 끈 직후 프로세스가 죽어도 끄기 대기가 남게 디스크에 쓰고 돌아온다(개인정보 쪽 표시라 apply()의 비동기 쓰기를 쓰지 않음).
     */
    private var s: Session
        get() = state
        set(v) {
            if (v.offPending != state.offPending || v.started != state.started)
                prefs.edit().putBoolean("offPending", v.offPending).putBoolean("started", v.started).commit()
            state = v
            syncCapture()
        }
    private var carStatus by mutableStateOf(CarStatus())
    private var server by mutableStateOf(DEFAULT_SERVER)
    private val picked = mutableStateListOf<String>().apply { addAll(FAMILY.map { it.name }) }
    private var error by mutableStateOf("")
    private var offer by mutableStateOf<Offer?>(null) // 지금 보이는 경유지 제안(T9)
    private var debug = false
    private var pendingRoute: List<String>? = null // 내비에 붙으면 보낼 목적지(디버그 인자)
    private var offers = 0L // 제안 번호. 늦게 온 콜백이 다른 제안을 건드리지 않게
    private var todos: Todos? = null // 지금 여행의 장소별 할 일(T40)
    private var todoList by mutableStateOf(emptyList<Todo>())
    /** 보이고 있는 도착 브리핑. place가 null이면 모든 장소(Gleo로 부름). 주차해 주행 제한이 풀렸을 때만 그린다. */
    private data class Brief(val place: String?)
    private var brief by mutableStateOf<Brief?>(null)
    private var visible = false // onStart ~ onStop
    private var resumed = false // 우리 화면이 앞: 마이크 서비스는 이때만 시작할 수 있다(T10)
    private var askedMic = false
    private lateinit var handoff: Handoff // Gleo와 마이크 주고받기(T41). ponytail: 화면이 다시 만들어지면(configChanges 밖, 글꼴·언어) 넘긴 상태는 옛 화면의 시간 초과로 풀린다
    /** Gleo로 '기록 멈추기'를 부름(T41). 동의는 그대로 두고 수음만 멈춘다. 앱이 다시 켜져도 멋대로 다시 기록하지 않게 저장한다. */
    private var muted by mutableStateOf(false)
    private lateinit var device: String // 보관함의 기기 값. 설치 단위(ADR-0014 초안의 device_id)
    private val uplink: Uplink = KEEP // ponytail: 발화 저장 API(T39)가 생기면 그 호출로 바꾼다. 지금은 보관함에 쌓기만

    /** 화면이 보이는 동안, 그리고 수음 중이면 화면 뒤에서도 조회해 폰에서 끈 동의를 반영한다. */
    private val tick = object : Runnable {
        override fun run() { refresh(); if (visible || s.recording) main.postDelayed(this, POLL_MS) }
    }

    /** 마이크(꼭 필요)와 알림(화면 뒤에서 '기록 멈춤'을 보이는 데 씀. 없으면 API 33부터 알림이 올라가지 않음)을 한 번에 묻는다. */
    private val askMic = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { got ->
        if (got[Manifest.permission.RECORD_AUDIO] == true) syncCapture() else Live.set(Mic.FAILED, "마이크 권한이 없어 기록할 수 없어요")
    }

    /**
     * 기록 상태(Session.recording)에 수음을 맞춘다. 동의가 빠지면 그 자리에서 멈추고 마이크를 놓는다.
     * 시작은 우리 화면이 앞일 때만. 화면 뒤에서 기록 중이 되면 앱을 열 때 시작한다.
     */
    private fun syncCapture() {
        val code = s.trip?.code
        if (!s.recording || code == null || muted) {
            if (!s.recording && muted) mute(false) // 기록이 끝나면 멈춤 표시도 푼다. 다시 켜면 새로 기록한다
            handoff.stop()
            if (CaptureService.running) CaptureService.stop(this)
            return
        }
        if (CaptureService.running || !resumed || Live.mic == Mic.FAILED) return
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            if (!askedMic) { askedMic = true; askMic.launch(arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS)) }
            else Live.set(Mic.FAILED, "마이크 권한이 없어 기록할 수 없어요")
            return
        }
        Live.outbox(this, code)
        CaptureService.start(this, code)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences("car", MODE_PRIVATE)
        handoff = Handoff(this, CaptureService::hold)
        muted = prefs.getBoolean("muted", false)
        // 실행 인자(--es server, --ei widthDp, --es route)는 디버그 빌드에서만 받는다. 밖에서 연 화면이 서버 주소를 바꾸지 못하게
        debug = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (debug) intent.getStringExtra("server")?.let { prefs.edit().putString("server", it).apply() }
        server = prefs.getString("server", null) ?: DEFAULT_SERVER
        device = prefs.getString("device", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("device", it).apply() }
        // 앱을 다시 켜도, 서버에 닿지 않아도 마지막으로 받은 여행과 끄기 대기를 이어 보여 준다
        s = Session.restore(prefs.getString("trip", null), prefs.getBoolean("offPending", false), prefs.getBoolean("started", false))
        s.trip?.let { Live.outbox(this, it.code) } // 앱을 다시 켜도 받아 적은 말과 순번을 이어 보여 준다
        car = Car(this) {
            carStatus = it; Live.gear = it.gear
            val was = s.gear
            s = s.withGear(it.gear)
            if (was != null && was != "P" && it.gear == "P") arrive() // 앱을 켤 때 처음 읽은 P는 도착이 아니다
            routeIfReady()
        }
        car.start()
        Live.onHeard = ::heard
        s.trip?.let { todosOf(it.code) }
        routeFrom(intent)
        if (savedInstanceState == null) gleo(intent) // 다시 만들어진 화면이 지난 호출에 또 답하지 않게
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors, typography = CarType) {
                ProvideTextStyle(TextStyle(fontSize = 24.sp)) {
                    // ponytail: 에뮬레이터는 창을 나누지 않아 반쪽 창을 --ei widthDp 841로 흉내 낸다. 실제 분할 창 확인은 실차에서
                    val w = if (debug) intent.getIntExtra("widthDp", 0) else 0
                    Surface(if (w > 0) Modifier.fillMaxHeight().width(w.dp) else Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                        val t = s.trip
                        when {
                            t != null -> TripScreen(t)
                            carStatus.restricted -> SetupLocked()
                            else -> Setup()
                        }
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); routeFrom(intent); gleo(intent) }

    /** 시연·E2E: --es route "위도,경도,이름"으로 내비에 목적지를 넣는다(디버그 빌드). 실제로는 운전자가 내비에서 정한다. */
    private fun routeFrom(i: Intent?) {
        if (debug) pendingRoute = i?.getStringExtra("route")?.split(",")?.takeIf { it.size == 3 } ?: pendingRoute
        routeIfReady()
    }

    private fun routeIfReady() {
        val (la, ln, name) = pendingRoute?.takeIf { carStatus.navi } ?: return
        pendingRoute = null
        car.route(Place(la.toDouble(), ln.toDouble(), name), emptyList())
    }

    override fun onStart() { super.onStart(); visible = true; main.removeCallbacks(tick); main.post(tick) }
    override fun onStop() { visible = false; super.onStop() }

    override fun onResume() {
        super.onResume()
        resumed = true
        if (Live.mic == Mic.FAILED) Live.set(Mic.OFF) // 앱을 다시 열면 한 번 더 시도한다
        syncCapture()
    }

    override fun onPause() { resumed = false; super.onPause() }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null) // 조회, 제안 시간 초과, 결과 카드 닫기
        if (Live.onHeard == ::heard) Live.onHeard = null
        if (!isChangingConfigurations) { handoff.stop(); CaptureService.stop(this) } // 동의를 확인할 화면이 없어지면 수음도 멈춘다
        car.stop(); io.shutdown(); super.onDestroy()
    }

    /** 통신은 한 줄로 차례대로 돌리고 결과만 메인 스레드로 돌려받는다. */
    private fun <T> bg(work: () -> T, done: (Result<T>) -> Unit) {
        if (!io.isShutdown) io.execute { val r = runCatching(work); main.post { done(r) } }
    }

    private fun keep(got: Server.Got): Trip { prefs.edit().putString("trip", got.json).apply(); return got.trip }

    private fun reason(e: Throwable) = if (e is ApiError) "서버가 거절했어요(${e.message})" else "서버에 닿지 않아요"

    private fun createTrip() {
        val members = FAMILY.filter { it.name in picked }
        val url = server
        prefs.edit().putString("server", url).apply()
        s = s.copy(busy = true); error = ""
        bg({
            val api = Server(url)
            val code = api.createTrip(TITLE).trip.code
            members.forEach { api.join(code, it) }
            api.trip(code)!!
        }) { r ->
            r.onSuccess { s = Session(gear = s.gear).withTrip(keep(it)); Live.outbox(this, it.trip.code) }
                .onFailure { s = s.copy(busy = false); error = "여행을 만들지 못했어요 · ${reason(it)}" }
        }
    }

    /** 최신 여행을 묻는다. 끄기를 서버에 아직 못 알렸으면 먼저 다시 보낸다. */
    private fun refresh() {
        val t = s.trip ?: return
        val off = s.offTargets
        val v = s.pollVersion
        val url = server
        val box = Live.box?.takeIf { it.trip == t.code }
        val dev = device
        bg({
            val api = Server(url)
            off.forEach { api.consent(t.code, it, false) }
            api.trip(t.code, v)
        }) { r ->
            r.onSuccess { got -> s = if (got == null) s.copy(online = true) else s.withTrip(keep(got)) }
                .onFailure { s = s.copy(online = it is ApiError, note = if (it is ApiError) reason(it) else s.note) }
        }
        // 받아 적은 말은 동의와 따로 보낸다. 지금은 KEEP이라 보내지 않고 남은 수만 다시 센다
        if (box != null) bg({ box.flush(uplink, dev) }) { Live.show(box) }
    }

    /** 켜기 직전에 기어를 다시 읽고, 서버가 모두의 동의를 저장한 뒤에만 '기록 중'으로 바꾼다. */
    private fun turnOn() {
        car.readGear { g ->
            s = s.withGear(g)
            s.blockOn()?.let { s = s.copy(note = it); return@readGear }
            val t = s.trip!!
            val url = server
            s = s.copy(busy = true, note = "")
            bg({
                val api = Server(url)
                t.people.forEach { api.consent(t.code, it.id, true) }
                api.trip(t.code)!!
            }) { r ->
                r.onSuccess { s = s.copy(busy = false).turnedOn(keep(it)); if (s.recording) car.speak("기록을 시작했어요") }
                    .onFailure { s = s.copy(busy = false, online = it is ApiError, note = "기록을 시작하지 못했어요 · ${reason(it)}") }
            }
        }
    }

    /** 끄기는 서버를 기다리지 않고 바로 멈춘다. 서버에는 refresh가 알린다. */
    private fun turnOff() {
        s = s.turnOff().copy(note = "")
        car.speak("기록을 멈췄어요")
        refresh()
    }

    private fun newTrip() {
        prefs.edit().remove("trip").commit()
        s = Session(gear = s.gear)
        offer = null; todos = null; todoList = emptyList(); brief = null
    }

    // ---- 부탁을 경유지로(T9). 서버의 부탁 상태: held → proposed → accepted → reflected, 못 넣으면 held(openapi.yaml) ----
    // 제안은 한 번에 하나(offer)이고 단계는 FINDING → ASKING → ADDING → ADDED·FAILED. 새 부탁은 열린 제안에 묶인다.

    /** 받아 적은 말 한 건(메인 스레드). Gleo 호출어(T41), 열린 제안에 대한 답, 쉬어 가자는 부탁, 장소가 붙은 할 일(T40), 모호한 답 순서로 본다. */
    private fun heard(u: Utterance) {
        val t = s.trip?.takeIf { it.code == u.trip } ?: return
        if (isWake(u.text)) { if (Live.mic == Mic.ON) handoff.give(wake = true); return }
        val o = offer?.takeIf { it.stage == Offer.Stage.ASKING }
        val a = answerOf(u.text)
        if (o != null && a != Answer.UNCLEAR) { // "그래, 쉬었다 가자"도 수락이다
            if (a == Answer.NO) later(o) else if (canAccept(u)) accept(o) else Log.i(TAG, "뒷줄의 수락은 받지 않음")
            return
        }
        if (isRestRequest(u.text)) return hold(t, u)
        todoOf(u.text)?.let { (place, text) ->
            // 도착 알림은 할 일을 그대로 읽는다. 그 소리가 마이크로 되돌아와 다시 모이지 않게, 우리가 말하는 동안 받아 적힌 할 일은 모으지 않는다
            if (car.ownVoice(u.startedAt + LEAD_MS)) { Log.i(TAG, "우리 말소리와 겹친 할 일은 모으지 않음"); return }
            val box = todosOf(t.code)
            if (box.add(place, text) == null) { Log.i(TAG, "같은 할 일이 있어 더하지 않음"); return }
            todoList = box.items
            Log.i(TAG, "할 일 보관 $place · 이 여행 ${box.open().size}건")
            return
        }
        if (o != null && o.asked < 2 && canAccept(u)) { // 한 번만 다시 묻는다. 답 낱말을 넣지 않는다(스피커 소리가 마이크로 되돌아와 답이 되지 않게)
            offer = o.copy(asked = 2)
            car.speak("${o.stop?.spoken}에 들를지 다시 말해 주세요")
        }
    }

    /**
     * 부탁을 서버에 남기고(held) 열린 제안에 묶는다. 열린 제안이 없거나 실패로 끝났으면 새 제안을 연다.
     * 누가 말했는지는 아직 모른다. ponytail: 운전석 참가자로 남긴다. 좌석 구역(T37)과 목소리 대조(T38)가 붙으면 그 사람으로.
     */
    private fun hold(t: Trip, u: Utterance) {
        val by = (t.people.firstOrNull { it.seat == Seat.ROW_1_LEFT.name } ?: t.people.firstOrNull())?.id ?: return
        val o = offer?.takeIf { it.trip == t.code && it.stage != Offer.Stage.FAILED } ?: Offer(++offers, t.code).also { offer = it; propose(it, u) }
        val url = server
        bg({ Server(url).request(t.code, by, u.text) }) { r ->
            r.onSuccess { id -> Log.i(TAG, "부탁 보관 $id"); join(o.id, id) }
                .onFailure {
                    Log.w(TAG, "부탁을 남기지 못함", it)
                    if (offer?.let { x -> x.id == o.id && x.requests.isEmpty() } == true) offer = null // 묶인 부탁이 없는 제안은 닫는다
                    car.speak(if (it is ApiError) "부탁을 남기지 못했어요" else "연결이 끊겨 부탁을 남기지 못했어요")
                }
        }
    }

    /** 서버에 남은 부탁을 그 제안에 묶고 제안의 단계만큼 상태를 따라가게 한다. 제안이 그사이 닫혔으면 보관(held)에 둔다. */
    private fun join(offerId: Long, id: String) {
        val o = offer?.takeIf { it.id == offerId } ?: return
        offer = o.copy(requests = o.requests + id)
        when (o.stage) {
            Offer.Stage.FINDING, Offer.Stage.FAILED -> {} // FINDING은 제안을 띄울 때 묶인 부탁을 함께 proposed로 바꾼다
            Offer.Stage.ASKING -> mark(o.trip, listOf(id), "proposed")
            Offer.Stage.ADDING -> mark(o.trip, listOf(id), "proposed", "accepted") // 같은 휴게소로 가는 중. 결과가 오면 함께 바뀐다
            Offer.Stage.ADDED -> { mark(o.trip, listOf(id), "proposed", "accepted", "reflected"); car.speak("${o.stop?.spoken}에 이미 들르기로 했어요") }
        }
    }

    /** 아직 지나치지 않은 가장 가까운 휴게소와 그곳까지의 거리·시간을 내비에 묻고 제안한다. 화면은 넘어가지 않는다. 답이 없으면 30초 뒤 보관. */
    private fun propose(o: Offer, u: Utterance) {
        car.here { lat, lng ->
            val stop = nextStop(lat, lng)
            if (stop == null) { Log.i(TAG, "남은 휴게소 없음 · 부탁은 보관"); if (offer?.id == o.id) offer = null; return@here }
            car.distanceTo(stop) { m, sec ->
                val cur = offer?.takeIf { it.id == o.id } ?: return@distanceTo
                offer = cur.copy(stop = stop, meters = m, seconds = sec, stage = Offer.Stage.ASKING)
                Log.i(TAG, "제안 ${stop.name} 부탁 ${cur.requests.size}건 · 최종 결과에서 ${System.currentTimeMillis() - u.endedAt}ms · 위치 ${lat != null}")
                car.speak("${stop.spoken}에 들를까요?")
                mark(cur.trip, cur.requests, "proposed")
                main.postDelayed({ offer?.takeIf { it.id == o.id && it.stage == Offer.Stage.ASKING }?.let { later(it, timedOut = true) } }, OFFER_MS)
            }
        }
    }

    /**
     * 서버의 부탁 상태를 path 순서대로 바꾼다. 모두 바뀐 부탁과, 통신이 안 된 것이 있었는지를 돌려준다.
     * 그사이 폰에서 취소된 부탁은 갈 수 없는 길이라 409로 빠진다(openapi.yaml).
     */
    private fun mark(code: String, ids: List<String>, vararg path: String, done: (List<String>, Boolean) -> Unit = { _, _ -> refresh() }) {
        val url = server
        bg({
            val api = Server(url)
            val errs = ids.map { id -> runCatching { path.forEach { api.requestStatus(code, id, it) } }.exceptionOrNull() }
            ids.filterIndexed { i, _ -> errs[i] == null } to errs.any { it != null && it !is ApiError }
        }) { r ->
            val (ok, offline) = r.getOrDefault(emptyList<String>() to true)
            Log.i(TAG, "부탁 ${ok.size}/${ids.size}건 ${path.last()}" + if (offline) " · 연결 끊김" else "")
            done(ok, offline)
        }
    }

    /**
     * 수락(말이나 화면): accepted가 된 부탁이 있으면 내비에 경유지를 넣고, onWaypointChanged(ADD)를 받으면 reflected.
     * ponytail: 연결이 끊겨 accepted로 바꾸지 못하면 넣지 않고 실패로 알린다(확인되지 않은 동작을 하지 않음). 그 부탁은 proposed로 남는다.
     */
    private fun accept(o: Offer) {
        val stop = o.stop ?: return
        if (offer?.id != o.id || o.stage != Offer.Stage.ASKING) return
        offer = o.copy(stage = Offer.Stage.ADDING)
        mark(o.trip, o.requests, "accepted") { ok, offline ->
            if (ok.isEmpty()) return@mark finish(o.id, Offer.Stage.FAILED, if (offline) "연결이 끊겨 경유지를 넣지 못했어요" else "부탁이 취소돼 경유지를 넣지 않았어요")
            Log.i(TAG, "경유지 요청 ${stop.name} 부탁 ${ok.size}건")
            car.speak("${stop.spoken}를 경유지로 추가하고 있어요")
            // 내비가 앞으로 나와 우리 화면은 가려진다. 판정과 서버 갱신은 화면과 무관하게 이어지고 결과는 말로 알린다
            car.addStop(stop) { added ->
                Log.i(TAG, "경유지 ${if (added) "반영" else "실패"} ${stop.name}")
                val ids = offer?.takeIf { it.id == o.id }?.requests ?: o.requests // ADDING 중에 묶인 부탁까지
                finish(o.id, if (added) Offer.Stage.ADDED else Offer.Stage.FAILED, if (added) "${stop.spoken}를 경유지로 추가했어요" else "경유지를 추가하지 못했어요. 부탁은 보관했어요")
                mark(o.trip, ids, if (added) "reflected" else "held")
            }
        }
    }

    /** 거절·나중에·답 없음: 부탁을 보관으로 되돌린다. 저절로 다시 제안하지 않는다. */
    private fun later(o: Offer, timedOut: Boolean = false) {
        if (offer?.id != o.id || o.stage != Offer.Stage.ASKING) return
        offer = null
        car.speak(if (timedOut) "답이 없어 부탁은 보관해 둘게요" else "부탁은 보관해 둘게요")
        mark(o.trip, o.requests, "held")
    }

    // ---- 도착 브리핑(T40) ----

    private fun todosOf(code: String): Todos = todos?.takeIf { it.trip == code } ?: Todos(filesDir, code).also { todos = it; todoList = it.items }

    /**
     * 기어가 P로 바뀐 때: 내비가 향하는 다음 곳(첫 경유지, 없으면 목적지)이 할 일의 장소면 그곳의 미완료 할 일을 알린다.
     * 그 앞의 휴게소 등에 서면 다음 곳이 그 휴게소라 알리지 않는다.
     * ponytail: 다음 곳에 닿기 전에 P로 바꿔도(신호 대기·주유소) 알린다. 남은 거리(remainDistance)로 거르는 것은
     * 차가 움직이는 데서 확인한 뒤 넣는다(에뮬레이터는 차를 옮기지 않아 남은 거리가 줄지 않음).
     */
    private fun arrive() {
        val box = s.trip?.let { todosOf(it.code) } ?: return
        if (box.open().isEmpty()) return
        car.nextStopName { next ->
            val place = box.open().map { it.place }.distinct().firstOrNull { arrivedAt(it, next) }
            Log.i(TAG, "주차 · 다음 곳 ${if (next == null) "모름" else "있음"} · 할 일 장소에 도착 ${place != null}")
            if (place != null) briefAt(place, speak = true)
        }
    }

    /** 도착 브리핑을 띄운다(주행 제한이 풀린 때만 그려짐). place가 null이면 모든 장소. */
    private fun briefAt(place: String?, speak: Boolean) {
        val open = todos?.open(place).orEmpty()
        brief = Brief(place).takeIf { open.isNotEmpty() }
        Log.i(TAG, "도착 브리핑 ${place ?: "전체"} ${open.size}건")
        if (speak && open.isNotEmpty()) car.speak(briefingLine(place, open))
    }

    private fun complete(item: Todo) {
        todos?.let { it.done(item.id); todoList = it.items }
        Log.i(TAG, "할 일 완료 · 남은 ${todos?.open()?.size}건")
        if (brief?.let { todos?.open(it.place).isNullOrEmpty() } == true) brief = null
    }

    /**
     * Gleo가 "도착해서 할 일 알려 줘"로 부른 때(assets/schema.json, component activity). 미완료 할 일 전체를 띄우고
     * Gleo에 결과를 돌려준다(Callback Schema: message는 영어, 항목은 data). 말은 Gleo가 하므로 우리 TTS는 쓰지 않는다.
     * Gleo는 함수 이름이나 '<패키지>.<함수 이름>'을 action으로 보낸다(11/1 프로브). 응답의 functionName은 schema의 함수 이름 그대로.
     */
    private fun gleo(i: Intent?) {
        when (i?.action?.substringAfterLast('.')) {
            GLEO_ARRIVAL -> arrivalTasks()
            GLEO_PAUSE -> {
                val on = s.recording
                if (on) { mute(true); syncCapture() }
                reply(GLEO_PAUSE, on, if (on) "Recording is paused. Ask to resume recording, or tap Resume on the screen." else "Recording is not on.")
            }
            GLEO_RESUME -> {
                val on = s.recording
                if (on) { mute(false); syncCapture() } // 우리 화면이 앞으로 나오면(onResume) 수음을 시작한다
                reply(GLEO_RESUME, on, if (on) "Recording resumed." else "Recording consent is off. Turn it on in the Gachita app while parked.")
            }
        }
    }

    private fun mute(on: Boolean) { prefs.edit().putBoolean("muted", on).commit(); muted = on; Log.i(TAG, "기록 멈추기 $on") }

    /** Gleo에 결과를 돌려준다(Callback Schema: message는 영어, 항목은 data). 말은 Gleo가 한다. ponytail: 실패 status 값은 Gleo 승인 뒤 확인. */
    private fun reply(fn: String, ok: Boolean, msg: String, data: String? = null) {
        val r = JSONObject().put("functionName", fn).put("status", if (ok) "success" else "fail").put("message", msg).put("mode", "voice")
        data?.let { r.put("data", it) }
        sendBroadcast(Intent("ai.pleos.playground.intent.action.APP_ACTION_RESPONSE").putExtra("packageName", packageName).putExtra("response", r.toString()))
        Log.i(TAG, "Gleo 응답 $fn ${r.getString("status")}")
    }

    private fun arrivalTasks() {
        s.trip?.let { todosOf(it.code) }
        briefAt(null, speak = false)
        val open = todos?.open().orEmpty()
        val msg = if (open.isEmpty()) "There are no to-do items for after arriving." else "Found ${open.size} to-do items for after arriving. The list is on the screen once the car is parked."
        Log.i(TAG, "Gleo 도착 할 일 ${open.size}건")
        reply(GLEO_ARRIVAL, true, msg, JSONArray(open.map { JSONObject().put("place", it.place).put("task", it.text) }).toString())
    }

    /** 제안을 결과 단계로 닫고 말로 알린다. 그 제안이 이미 바뀌었으면(새 여행) 화면은 두고 말도 하지 않는다. */
    private fun finish(id: Long, stage: Offer.Stage, say: String) {
        val done = offer?.takeIf { it.id == id }?.copy(stage = stage) ?: return
        offer = done
        car.speak(say)
        main.postDelayed({ if (offer === done) offer = null }, RESULT_MS)
    }

    @OptIn(ExperimentalLayoutApi::class)
    @Composable
    private fun Setup() {
        val c = MaterialTheme.colorScheme
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(32.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            Text("여행 만들기", fontSize = 40.sp, fontWeight = FontWeight.Bold)
            Text("같이 타는 가족을 골라 주세요", color = c.onSurfaceVariant)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                FAMILY.forEach { m ->
                    val on = m.name in picked
                    FilterChip(
                        selected = on,
                        onClick = { if (on) picked.remove(m.name) else picked.add(m.name) },
                        label = { Text("${m.name} · ${m.seat.label}", Modifier.padding(vertical = 16.dp, horizontal = 8.dp)) },
                    )
                }
            }
            OutlinedTextField(server, { server = it }, Modifier.fillMaxWidth(), label = { Text("서버 주소", fontSize = 18.sp) }, singleLine = true)
            Button(::createTrip, Modifier.heightIn(min = 72.dp), enabled = !s.busy && picked.isNotEmpty()) {
                Text(if (s.busy) "여행을 만들고 있어요" else "여행 만들기", fontSize = 26.sp)
            }
            if (error.isNotEmpty()) Text(error, color = c.error)
        }
    }

    /** 주행 제한 중에는 여행 만들기(가족 고르기·서버 주소 입력)가 설정·키보드라 가린다(T11, NO_SETUP). */
    @Composable
    private fun SetupLocked() {
        Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            Text("여행 만들기", fontSize = 40.sp, fontWeight = FontWeight.Bold)
            Card { Text("주차(P)한 뒤 여행을 만들 수 있어요", fontSize = 30.sp, fontWeight = FontWeight.Bold) }
        }
    }

    /**
     * 주행 제한 중(T11): 기록 상태 → 받아 적은 말 두 줄 → 일행 → 보관한 부탁 수 → 기록 끄기 → 연결 상태만 24sp 이상으로 보인다.
     * 설명·진단 줄(20sp)과 새 여행 만들기는 가린다. 1682 × 1210 창은 두 칸, 반쪽(약 841 × 1210)은 한 칸에 기록 → 가족 → 부탁 → 조작 순서로 쌓는다(frontend/spec/car.md). */
    @Composable
    private fun TripScreen(t: Trip) {
        BoxWithConstraints(Modifier.fillMaxSize().padding(32.dp)) {
            if (maxWidth >= 1200.dp) {
                Row(horizontalArrangement = Arrangement.spacedBy(32.dp)) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(24.dp)) { Summary(t) }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(24.dp)) { Controls(t) }
                }
            } else {
                Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(24.dp)) { Summary(t); Controls(t) }
            }
        }
    }

    @Composable
    private fun Summary(t: Trip) {
        val c = MaterialTheme.colorScheme
        Card {
            if (s.recording && muted) {
                Text("기록 멈춤", fontSize = 48.sp, fontWeight = FontWeight.Bold)
                Text("Gleo로 멈췄어요 · 동의는 그대로예요", color = c.onSurfaceVariant)
                Button({ mute(false); syncCapture() }, Modifier.heightIn(min = 72.dp)) { Text("다시 기록", fontSize = 26.sp) }
            } else if (s.recording && handoff.state != Handoff.State.OFF) {
                Text("기록 잠시 멈춤", fontSize = 48.sp, fontWeight = FontWeight.Bold)
                Text(if (handoff.state == Handoff.State.WAITING) "운전대 버튼을 누르세요" else "Gleo가 끝나면 다시 기록해요", fontSize = 30.sp, fontWeight = FontWeight.Bold)
            } else if (s.recording) {
                when (Live.mic) {
                    Mic.ON -> {
                        Text("● 기록 중", fontSize = 48.sp, fontWeight = FontWeight.Bold, color = c.error)
                        Text(Live.why.ifEmpty { "동의를 끄면 바로 멈춰요" }, color = c.onSurfaceVariant)
                    }
                    Mic.BLOCKED, Mic.FAILED -> {
                        Text("기록 멈춤", fontSize = 48.sp, fontWeight = FontWeight.Bold, color = c.error)
                        Text(if (Live.mic == Mic.BLOCKED) "마이크가 막혔어요 · 앱을 열어 두면 다시 기록해요" else Live.why, color = c.onSurfaceVariant)
                    }
                    else -> {
                        Text("기록 준비", fontSize = 48.sp, fontWeight = FontWeight.Bold)
                        Text("기록을 시작하고 있어요", color = c.onSurfaceVariant)
                    }
                }
            } else if (s.waiting) {
                Text("기록 대기", fontSize = 48.sp, fontWeight = FontWeight.Bold)
                Text("주차(P)하면 기록을 시작해요", color = c.onSurfaceVariant)
            } else {
                Text("기록 꺼짐", fontSize = 48.sp, fontWeight = FontWeight.Bold)
                Text(
                    when {
                        s.offPending -> "기록을 멈췄어요"
                        t.people.any { it.consent } -> "모두 동의하면 다시 기록할 수 있어요"
                        else -> "주차(P)한 뒤 대화 기록 동의를 켜면 기록해요"
                    },
                    color = c.onSurfaceVariant,
                )
            }
        }
        brief?.takeIf { !carStatus.restricted }?.let { BriefCard(it) } // 주행 중에는 목록을 띄우지 않는다(T40)
        offer?.takeIf { it.stage != Offer.Stage.FINDING }?.let { OfferCard(it) }
        if (s.recording || Live.count > 0) Heard()
        Card {
            Text("일행 ${t.people.size}명", fontSize = 30.sp, fontWeight = FontWeight.Bold)
            t.people.forEach { p ->
                val seat = runCatching { Seat.valueOf(p.seat).label }.getOrDefault(p.seat)
                Text("${p.name} · $seat" + if (p.consent) " · 동의" else "")
            }
        }
        Card {
            Text(if (t.heldRequests == 0) "보관한 부탁이 없어요" else "보관한 부탁 ${t.heldRequests}건", fontSize = 30.sp, fontWeight = FontWeight.Bold)
            val open = todoList.count { !it.done }
            if (open > 0) Text("도착해서 할 일 ${open}건")
        }
    }

    /**
     * 방금 받아 적은 말 두 줄. 주행 중 화면 기준(docs/emulator/README.md): 글자 24sp 이상, 자동 스크롤·움직이는 표시 없음.
     * 긴 대화 기록은 주행 중에 보이지 않는다(frontend/spec/car.md). 한 줄은 두 줄까지만 보이고 넘치면 줄임표.
     */
    @Composable
    private fun Heard() {
        val c = MaterialTheme.colorScheme
        val hm = SimpleDateFormat("HH:mm", Locale.KOREA)
        Card {
            Text("받아 적은 말 ${Live.count}건", fontSize = 30.sp, fontWeight = FontWeight.Bold)
            if (Live.recent.isEmpty()) Text("아직 받아 적은 말이 없어요", color = c.onSurfaceVariant)
            Live.recent.asReversed().forEach { u ->
                Text("${hm.format(Date(u.startedAt))} · ${u.text}", maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (Live.pending > 0 && !carStatus.restricted) Text("서버에 보내지 않고 이 차에 보관 중 ${Live.pending}건", color = c.onSurfaceVariant, fontSize = 20.sp)
        }
    }

    /** 도착 브리핑(T40): 장소의 미완료 할 일과 항목마다 '완료'. 받아 적은 말 그대로 보인다. */
    @Composable
    private fun BriefCard(b: Brief) {
        val items = todoList.filter { !it.done && (b.place == null || it.place == b.place) }
        Card {
            Text(if (b.place != null) "${b.place}에서 할 일" else "도착해서 할 일", fontSize = 36.sp, fontWeight = FontWeight.Bold)
            items.forEach { item ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    Text((if (b.place == null) "${item.place} · " else "") + item.text, Modifier.weight(1f))
                    OutlinedButton({ complete(item) }, Modifier.heightIn(min = 64.dp)) { Text("완료") }
                }
            }
            OutlinedButton({ brief = null }, Modifier.heightIn(min = 64.dp)) { Text("닫기") }
        }
    }

    /** 경유지 제안(T9). 주행 중에도 한 번 누르는 단추 둘만. 거리·시간은 그곳까지이고 들르면 늘어나는 시간이 아니다. */
    @Composable
    private fun OfferCard(o: Offer) {
        val c = MaterialTheme.colorScheme
        Card {
            when (o.stage) {
                Offer.Stage.ASKING -> {
                    Text("${o.stop?.spoken}에 들를까요?", fontSize = 36.sp, fontWeight = FontWeight.Bold)
                    Text(listOf(distanceLabel(o.meters, o.seconds), "부탁 ${o.requests.size}건").filter { it.isNotEmpty() }.joinToString(" · "), color = c.onSurfaceVariant)
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        // 그린 뒤에 묶인 부탁이 빠지지 않게 누른 때의 제안으로 부른다
                        Button({ offer?.let(::accept) }, Modifier.heightIn(min = 72.dp)) { Text("경유지로 추가", fontSize = 26.sp) }
                        OutlinedButton({ offer?.let { later(it) } }, Modifier.heightIn(min = 72.dp)) { Text("나중에", fontSize = 26.sp) }
                    }
                }
                Offer.Stage.FINDING -> {}
                Offer.Stage.ADDING -> Text("내비에 경유지를 추가하고 있어요", fontSize = 30.sp, fontWeight = FontWeight.Bold)
                Offer.Stage.ADDED -> {
                    Text("경유지를 추가했어요", fontSize = 30.sp, fontWeight = FontWeight.Bold, color = c.tertiary)
                    Text("${o.stop?.spoken} · 부탁 ${o.requests.size}건")
                }
                Offer.Stage.FAILED -> {
                    Text("경유지를 추가하지 못했어요", fontSize = 30.sp, fontWeight = FontWeight.Bold, color = c.error)
                    Text("부탁은 보관했어요")
                }
            }
        }
    }

    @Composable
    private fun Controls(t: Trip) {
        val c = MaterialTheme.colorScheme
        Card {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("대화 기록 동의", fontSize = 30.sp, fontWeight = FontWeight.Bold)
                    if (!carStatus.restricted) Text("기본값은 꺼짐 · 주차 중에만 켤 수 있어요", color = c.onSurfaceVariant, fontSize = 20.sp)
                }
                Switch(s.agreed, { if (it) turnOn() else turnOff() }, enabled = !s.busy && (s.agreed || !carStatus.restricted)) // 주행 제한 중에는 끄기(한 번 누름)만
            }
            if (s.note.isNotEmpty()) Text(s.note, color = c.error)
            // 우리가 수음하는 동안 Gleo는 운전대 버튼을 무시한다. 한 번 눌러 마이크를 넘긴다(T41). 주행 중에도 한 번 누름이라 둔다
            if (s.recording && !muted && Live.mic == Mic.ON && handoff.state == Handoff.State.OFF)
                OutlinedButton({ handoff.give(wake = false) }, Modifier.heightIn(min = 72.dp)) { Text("Gleo 쓰기", fontSize = 26.sp) }
        }
        Card {
            if (s.online) Text("서버에 연결됐어요", color = c.tertiary)
            else Text("연결이 끊겼어요 · 마지막으로 확인한 정보예요", color = c.error)
            if (!carStatus.restricted) {
                Text("기어 ${s.gear ?: "모름"} · 내비 ${if (carStatus.navi) "연결됨" else "연결 안 됨"} · 음성 ${if (carStatus.voice) "준비됨" else "준비 안 됨"}", color = c.onSurfaceVariant, fontSize = 20.sp)
                Text("여행 코드 ${t.code}", color = c.onSurfaceVariant, fontSize = 20.sp)
            }
        }
        if (!carStatus.restricted) OutlinedButton(::newTrip, Modifier.heightIn(min = 64.dp), enabled = !s.agreed && !s.busy) { Text("새 여행 만들기") }
    }

    @Composable
    private fun Card(content: @Composable () -> Unit) {
        val c: ColorScheme = MaterialTheme.colorScheme
        Surface(Modifier.fillMaxWidth(), RoundedCornerShape(20.dp), color = c.surface, border = BorderStroke(1.dp, c.outline)) {
            Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { content() }
        }
    }
}
