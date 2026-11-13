package io.github.teampitcrew.gachita

import android.Manifest
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.SurfaceTexture
import android.view.Surface
import android.view.TextureView
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilledTonalButton
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.unit.sp
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

private const val DEFAULT_SERVER = "https://gachita.mangowhois.ai" // 실서비스(T27). 로컬 서버는 디버그 빌드에서 '서버 주소'나 --es server로
private const val POLL_MS = 10_000L // 웹앱은 2초. 차에서는 주행 중 자원 기준(CPU 5% 미만)을 생각해 길게 둔다
private const val TITLE = "가치타 가족 여행"
private const val TAG = "GachitaAsk"
private const val RESULT_MS = 60_000L // 경유지 결과 카드를 보여 두는 시간
private const val GLEO_ARRIVAL = "GACHITA_ARRIVAL_TASKS" // assets/schema.json의 함수 이름(T40)
private const val GLEO_PAUSE = "GACHITA_PAUSE_RECORDING" // 같은 곳(T41)
private const val GLEO_RESUME = "GACHITA_RESUME_RECORDING"
private const val RESYNC_EVERY = 30 // 조회 30번(5분)마다, 그리고 끊겼다 다시 닿을 때 서버의 확인 순번을 다시 받는다(ADR-0014 2절). 5분마다는 서버에서 지운 글도 차 사본에 맞춘다(T69)
private const val MATCH_MAX = 20 // 한 차례에 대조할 발화 수. 밀린 것이 많아도 통신 줄을 오래 잡지 않게
private const val OFFER_MS = 30_000L // 제안에 답이 없으면 보관으로 되돌리는 시간. 그사이 휴게소를 지나칠 수 있어 길게 두지 않는다

class MainActivity : ComponentActivity() {
    private val io = Executors.newSingleThreadExecutor()
    private val clipIo = Executors.newSingleThreadExecutor() // 장면 클립 올리기(T63). 동의 끄기 요청이 클립 묶음 뒤에 서지 않게 따로
    @Volatile private var clipsAllowed = false // 모두 동의했고 끄기 대기가 없음. 클립을 하나 올릴 때마다 본다
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
            clipsAllowed = v.consented && !v.offPending // 끄면 남은 클립을 더 올리지 않는다
            syncCapture() // 동의가 빠졌으면 수음을 먼저 멈춘다
            v.trip?.let { t ->
                // 등록값은 그 사람의 동의가 꺼지면 서버가 지운다. 꺼졌다 10초 안에 다시 켜져 차가 못 봤어도 세대가 오르므로 세대가 바뀌면 다시 등록한다
                val gen = "${t.code}:${t.generation}"
                voiced.filter { id -> voicedAt == gen && t.people.any { it.id == id && it.consent } }.toSet().takeIf { it != voiced || voicedAt != gen }?.let {
                    voiced = it; voicedAt = gen; prefs.edit().putString("voiced", "$gen:" + it.joinToString(",")).apply()
                }
                speakersOf(t.code).see(t.generation)
                val box = Live.outbox(this, t.code)
                if (box.see(t.generation, t.createdAt)) Live.show(box) // 동의 세대가 오르면 옛 세대 발화의 글을 지운다
                if (v.consented) Live.rawGen = box.generation // 원음은 모두 동의한 세대로만 남긴다(T63)
                if ("${t.code}:${box.generation}" != rawSeen) { rawSeen = "${t.code}:${box.generation}"; dropRaw(filesDir, t.code, below = box.generation) } // 옛 세대의 원음은 지운다
            }
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
    private var clipping = false // 장면 클립을 올리는 중(T63)
    private var rawSeen = "" // 옛 세대 원음을 지운 여행·세대. 세대가 바뀔 때만 파일 목록을 본다
    private var speakers: Speakers? = null // 지금 여행의 발화별 말한 사람(T37)
    private var matching = false // 대조·고침 보내기가 clipIo에 있음
    private var heardTick by mutableStateOf(0) // 말한 사람이 바뀌면 받아 적은 말 카드를 다시 그린다
    /** 이 차에서 목소리를 등록한 참가자. 그 사람의 동의가 꺼지면 서버가 등록값을 지우므로 여기서도 뺀다(#65). */
    private var voiced by mutableStateOf(emptySet<String>())
    private var voicedAt = "" // voiced가 맞는 여행·동의 세대
    private var enrolling by mutableStateOf<Person?>(null)
    private var voiceNote by mutableStateOf("")
    private var clipsAfter = 0L // 다시 해도 되는 실패(403·503·끊김) 뒤에는 이때까지 쉰다. 큰 원음 파일을 10초마다 다시 읽지 않게
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
    // 동승 연결(T46): 주차 중 탑승자 폰의 QR을 읽고(scanning) 고른 자리에 넣는다(rideQr = 읽은 QR 글자)
    private var scanning by mutableStateOf(false)
    private var rideQr by mutableStateOf<String?>(null)
    private var rideNote by mutableStateOf("")
    private val askCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) scanning = true else rideNote = "카메라 권한이 없어 QR을 읽을 수 없어요"
    }
    // 숏폼 그 자리 재생(T43). 장면 클립을 차례로 틀고 자막과 말한 사람을 보인다. 주차 중에만
    private var short by mutableStateOf<Short?>(null)
    private var shortAt by mutableStateOf(-1) // 재생 중인 장면. -1이면 틀지 않음
    private var shortPos by mutableStateOf(0.0) // 그 장면의 초
    private var shortPaused by mutableStateOf(false)
    private var shortNote by mutableStateOf("")
    private var player: MediaPlayer? = null
    private var shortGen = 0 // 장면을 열 때마다 하나씩. 늦게 끝난 받기가 닫힌 숏폼이나 다른 장면을 건드리지 않게
    private var shortFile: File? = null // 지금 트는 장면의 클립(장면마다 다른 파일, 닫으면 지움)
    private val media = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
    /** 사용자 음악은 듣는 동안만 멈춘다. 전화·Gleo 등이 포커스를 가져가면 닫는다(내비 안내처럼 줄여 달라는 것은 시스템이 줄임). */
    private val playFocus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(media)
        .setOnAudioFocusChangeListener({ if (it == AudioManager.AUDIOFOCUS_LOSS || it == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) stopShort() }, Handler(Looper.getMainLooper())).build()
    private val shortTick = object : Runnable { override fun run() { player?.let { shortPos = it.currentPosition / 1000.0; main.postDelayed(this, 200) } } }
    private lateinit var device: String // 보관함의 기기 값. 설치 단위(ADR-0014의 device)
    /** 이 차가 참가시킨 사람의 참가자 토큰(id → 토큰). 그 사람의 동의 켜기와 발화 올리기에 쓴다(T68). 참가할 때 한 번만 온다. */
    private var tokens: Map<String, String> = emptyMap()
    private var uploading = false // 올리기가 통신 줄에 있음. 느린 길에서 조회마다 쌓여 동의 확인을 밀어내지 않게

    /** 화면이 보이는 동안, 그리고 수음 중이면 화면 뒤에서도 조회해 폰에서 끈 동의를 반영한다. */
    private val tick = object : Runnable {
        private var n = 0
        override fun run() {
            val every = ++n % RESYNC_EVERY == 0
            if (every) expire() // 앱이 며칠 켜져 있어도 48시간이 지난 사본을 지운다
            refresh(resync = every || !s.online, prune = every); locate()
            if (visible || s.recording) main.postDelayed(this, POLL_MS)
        }
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
        // 여행을 만든 뒤 48시간이 지난 차 안 사본을 지운다(T69). 시험용으로 보관 기간을 줄이는 --el keepMs는 디버그 빌드에서만
        val now = System.currentTimeMillis()
        val keepMs = if (debug) intent.getLongExtra("keepMs", KEEP_MS) else KEEP_MS
        sweep(filesDir, Live.seal(this), now, keepMs).forEach(Live::forget) // 서비스 때문에 프로세스가 살아 있던 경우
        // 저장한 여행과 참가자 토큰도 받아 적은 말(부탁)과 인증 값이라 암호화해 둔다. 열리지 않거나(키가 바뀜) 보관 기간이 지났으면 없는 것으로
        fun unsealed(k: String) = prefs.getString(k, null)?.let { runCatching { Live.seal(this).unline(it) }.getOrNull() }
        val saved = unsealed("trip")?.takeIf { j -> runCatching { now - parseTrip(j).createdAt <= keepMs }.getOrDefault(false) }
        if (saved == null) prefs.edit().remove("trip").remove("tokens").commit()
        tokens = unsealed("tokens")?.let { j -> JSONObject(j).let { o -> o.keys().asSequence().associateWith { o.getString(it) } } }.orEmpty()
        // 앱을 다시 켜도, 서버에 닿지 않아도 마지막으로 받은 여행과 끄기 대기, 받아 적은 말과 순번을 이어 보여 준다
        prefs.getString("voiced", null)?.split(":")?.takeIf { it.size == 3 }?.let { (code, gen, ids) -> voicedAt = "$code:$gen"; voiced = ids.split(",").filter { it.isNotEmpty() }.toSet() }
        s = Session.restore(saved, prefs.getBoolean("offPending", false), prefs.getBoolean("started", false), tokens.keys)
        if (s.offPending) s.trip?.let { dropRawAll(it.code) } // 끈 뒤 지우기 전에 앱이 꺼졌으면 마저 지운다
        car = Car(this) {
            carStatus = it
            if (it.restricted) scanning = false // 주행 중에는 카메라를 닫는다(T11). 카드도 그리지 않는다
            if (it.restricted && shortAt >= 0) stopShort() // 주행 중에는 숏폼을 틀지 않는다(T11)
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
            GachitaTheme {
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
        stopShort()
        main.removeCallbacksAndMessages(null) // 조회, 제안 시간 초과, 결과 카드 닫기
        if (Live.onHeard == ::heard) Live.onHeard = null
        if (!isChangingConfigurations) { handoff.stop(); CaptureService.stop(this) } // 동의를 확인할 화면이 없어지면 수음도 멈춘다
        car.stop(); io.shutdown(); clipIo.shutdownNow(); super.onDestroy()
    }

    /** 통신은 한 줄로 차례대로 돌리고 결과만 메인 스레드로 돌려받는다. */
    private fun <T> bg(work: () -> T, done: (Result<T>) -> Unit) {
        if (!io.isShutdown) io.execute { val r = runCatching(work); main.post { done(r) } }
    }

    private fun keep(got: Server.Got): Trip { prefs.edit().putString("trip", Live.seal(this).line(got.json)).apply(); return got.trip }

    private fun reason(e: Throwable) = if (e is ApiError) "서버가 거절했어요(${e.message})" else "서버에 닿지 않아요"

    private fun createTrip() {
        val members = FAMILY.filter { it.name in picked }
        val url = server
        prefs.edit().putString("server", url).apply()
        s = s.copy(busy = true); error = ""
        bg({
            val api = Server(url)
            val code = api.createTrip(TITLE).trip.code
            val got = members.associate { api.join(code, it) }
            api.trip(code)!! to got
        }) { r ->
            r.onSuccess { (got, mine) ->
                tokens = mine
                prefs.edit().putString("tokens", Live.seal(this).line(JSONObject(mine).toString())).commit() // 다시 받을 수 없는 값이라 디스크에 쓰고 돌아온다
                s = Session(gear = s.gear, ours = mine.keys).withTrip(keep(got))
            }
                .onFailure { s = s.copy(busy = false); error = "여행을 만들지 못했어요 · ${reason(it)}" }
        }
    }

    /**
     * 최신 여행을 묻는다. 끄기를 서버에 아직 못 알렸으면 먼저 다시 보낸다. 서버가 여행을 모르면(48시간이 지나 지워짐) 차 안 사본도 지운다.
     * resync면 보낼 발화가 없어도 서버의 확인 순번을 다시 받는다(서버 DB가 백업에서 되살아나 내려갔으면 그 뒤부터 다시 보냄).
     * prune이면 이어서 참가자가 서버에서 지운 글을 차 사본에서도 지운다(T69). ponytail: 이 기기 발화 전체 목록을 받음. 순번만 주는 길이 생기면 바꾼다
     */
    private fun refresh(resync: Boolean = false, prune: Boolean = false) {
        val t = s.trip ?: return
        val off = s.offTargets
        val v = s.pollVersion
        val url = server
        bg({
            val api = Server(url)
            off.forEach { api.consent(t.code, it, false) }
            api.trip(t.code, v)
        }) { r ->
            r.onSuccess { got ->
                if (s.trip?.code != t.code) return@onSuccess // 그사이 지운 여행(48시간·404)이나 새 여행: 늦게 온 응답으로 되살리지 않는다
                s = if (got == null) s.copy(online = true) else s.withTrip(keep(got))
                upload(t, resync, prune) // 받은 여행의 동의 세대를 보관함에 반영한(철회면 글을 지운) 뒤에만 올린다
                speakers(t) // 올릴 새 발화가 없어도 밀린 대조와 고침을 잇는다
                s.trip?.let(::clips)
            }
                .onFailure { if (it is Gone) forget(t.code) else s = s.copy(online = it is ApiError, note = if (it is ApiError) reason(it) else s.note) } // 조회를 못 하면 이번에는 올리지 않는다
        }
    }

    /** 받아 적은 말을 올린다. 여행 조회가 성공해 그 응답을 반영한 뒤에만 부른다(끊긴 사이 철회됐으면 지운 뒤에 올리게). */
    private fun upload(t: Trip, resync: Boolean, prune: Boolean) {
        val url = server
        val box = Live.box?.takeIf { it.trip == t.code }
        val dev = device
        val up = tokens.minByOrNull { it.key }?.value // 올리는 사람은 늘 같은 참가자(서버는 기기를 처음 올린 참가자에 묶는다)
        // 받아 적은 말은 동의와 따로 보낸다. 못 보내면(끊김, 동의 대기 403) 보관함에 두었다 다음 조회에 다시 보낸다.
        // 지운 글 맞추기는 같은 차례에 받은 lastSeq 안에서만 한다(빈 묶음이라도 먼저 보냄). 되살린 DB에서 잃은 순번을 지운 것으로 보지 않게
        val again = (resync || prune) && box != null && box.acked > 0
        if (box == null || up == null || (box.pending == 0 && !again) || uploading || s.offPending) return
        uploading = true
        bg({
            val api = Server(url)
            box.flush({ d, items -> api.utterances(t.code, up, d, items) }, dev, always = again)
            if (prune && again && box.prune(api.keptSeqs(t.code, up, dev))) Log.i(TAG, "서버에서 지운 글을 차에서도 지움")
        }) { r ->
            uploading = false
            r.exceptionOrNull()?.let { Log.w(TAG, "발화 올리기 못 함 ${if (it is ApiError) it.message else "연결"}") } // 서버 거절(400 등)의 글에는 받아 적은 말이 없다
            if (r.exceptionOrNull() is Gone) forget(t.code) else if (Live.box === box) Live.show(box) // 그사이 지운 여행은 다시 보이지 않게
            if (s.trip?.code == t.code) speakers(t) // 이번에 서버가 받은 발화의 말한 사람
        }
    }

    /**
     * 말한 사람(T37): 서버가 받았지만 아직 대조하지 않은 발화(한 차례 20건)와, 사람이 고쳤지만 서버에 남기지 못한 것을 처리한다.
     * 올릴 새 발화가 있든 없든 조회마다 본다(밀린 대조를 이어 하게). 대조는 원음을 보내므로 클립과 같은 따로 둔 실행기에서 돌고,
     * 요청마다 '모두 동의, 끄기 대기 없음'을 다시 본다(동의를 끄면 남은 원음을 보내지 않고, 끄기 요청이 그 뒤에 서지 않게).
     */
    private fun speakers(t: Trip) {
        val box = Live.box?.takeIf { it.trip == t.code } ?: return
        val up = tokens.minByOrNull { it.key }?.value ?: return
        if (matching || !clipsAllowed) return
        val sp = speakersOf(t.code)
        // 등록값이 있을 만할 때만 대조한다(이 차에서 등록했거나 프로필 참가자가 있음)
        val todo = if (voiced.isNotEmpty() || t.people.any { it.profile }) box.ackedAfter(sp.through).take(MATCH_MAX) else emptyList()
        val fixes = sp.unsent()
        if (todo.isEmpty() && fixes.isEmpty()) return
        matching = true
        val url = server; val dev = device
        if (!clipIo.isShutdown) clipIo.execute {
            val r = runCatching {
                val api = Server(url)
                for ((seq, f) in fixes) { api.fixSpeaker(t.code, up, dev, seq, f.who); sp.set(seq, f.copy(sent = true)) }
                match(api, t.code, up, dev, todo, sp)
            }
            main.post {
                matching = false; heardTick++
                r.exceptionOrNull()?.let { Log.i(TAG, "말한 사람 대조·고침 미룸 ${if (it is ApiError) it.status else "연결"}") }
            }
        }
    }

    /** 48시간이 지난 여행의 차 안 사본을 지운다. 지금 여행이면 기록을 멈추고 처음 화면으로. */
    private fun expire() {
        sweep(filesDir, Live.seal(this), System.currentTimeMillis()).forEach { code ->
            Live.forget(code)
            if (s.trip?.code == code) { newTrip(); error = "만든 지 48시간이 지난 여행이라 이 차에 남은 기록을 지웠어요" }
        }
    }

    /**
     * 사람이 확정한 장면(moments)의 구간을 이 차의 원음에서 16 kHz 모노 WAV로 잘라 올린다(T63 → T76 POST /recordings). 모두 동의한 동안만.
     * 구간이 끝나고 3초가 지난 장면만 본다(아직 녹음 중인 구간을 자르지 않게). 원음이 이 차에 없거나 서버가 버리라고 하면(400·404·409·413) 다시 하지 않는다.
     * ponytail: 차 앱이 켜져 있을 때만 올린다. 폰에서 장면을 고른 뒤 차가 꺼져 있으면 다음에 앱을 켤 때(48시간 안).
     */
    private fun clips(t: Trip) {
        val up = tokens.minByOrNull { it.key }?.value ?: return
        val now = System.currentTimeMillis()
        if (clipping || now < clipsAfter || !s.consented) return
        val log = ClipLog(filesDir, t.code)
        val done = log.done()
        val todo = t.moments.filter { it.id !in done && it.window.last + 3_000 < now }
        if (todo.isEmpty()) return
        clipping = true
        val url = server; val dir = filesDir
        val done2: (Result<Unit>) -> Unit = { r ->
            clipping = false
            r.exceptionOrNull()?.let { clipsAfter = System.currentTimeMillis() + 5 * 60_000; Log.i(TAG, "클립 올리기 미룸 ${if (it is ApiError) it.status else "연결"}") }
        }
        if (!clipIo.isShutdown) clipIo.execute { val r = runCatching {
            val api = Server(url)
            val files = RawFile.of(dir, t.code)
            for (m in todo) {
                if (!clipsAllowed) break // 그사이 동의를 껐으면(철회) 남은 클립은 올리지 않는다
                val w = m.window
                val f = clipFile(files, w)
                val pcm = f?.let { runCatching { it.cut(Live.seal(this), w.first, w.last) }.getOrNull() }
                if (f == null || pcm == null) { log.add(m.id); Log.i(TAG, "장면 ${m.id}: 이 차에 그 구간의 원음이 없어 올리지 않음"); continue }
                try {
                    api.recording(t.code, up, m.id, f.generation, maxOf(w.first, f.startedAt), wav(pcm))
                    log.add(m.id); Log.i(TAG, "장면 ${m.id} 클립 ${pcm.size / 32}ms 올림")
                } catch (e: ApiError) {
                    if (e.status in listOf(400, 404, 409, 413)) { log.add(m.id); Log.i(TAG, "장면 ${m.id} 클립 버림 ${e.status}") } else throw e
                }
            }
        }; main.post { done2(r) } }
    }

    /**
     * 이 여행의 원음 지우기(사람의 요청, T63). 지난 것을 지우는 요청이라 동의 철회(앞으로를 멈춤)와 다르다(ADR-0007): 기록은 이어 가고 받아 적은 글·올린 클립은 그대로.
     * 수음 중이면 쓰던 파일까지 수음 스레드가 지우고 새 파일로 이어 쓴다.
     */
    private fun dropRawNow() {
        val t = s.trip ?: return
        val n = dropRawAll(t.code) // 쓰던 파일도(닫히면 그 자리가 비워진다)
        if (CaptureService.running) Live.rollRaw = t.code // 수음 스레드는 다음 묶음부터 새 파일에
        s = s.copy(note = if (n > 0) "이 차에 둔 지난 원음을 지웠어요" else "이 차에 둔 원음이 없어요")
    }

    /** 그 여행의 원음을 모두 지운다. 원음 쓰기와 같은 잠금 안에서(쓰던 파일까지). 지운 파일 수. */
    private fun dropRawAll(code: String): Int = synchronized(RAW_LOCK) { RawFile.of(filesDir, code).count { it.file.delete() } }

    /**
     * 말한 사람(T37, #65): 서버가 받은 발화마다 이 차의 원음에서 그 구간(첫 결과 쪽 0.5초를 빼고 10초까지)을 잘라 목소리 대조를 부른다(통신 스레드).
     * 좌석 구역이 있으면 그 줄(row)의 사람만 후보다. 서버가 찾으면 그 발화 줄에 화자를 붙이고, 차는 결과를 남겨 화면에 보인다. 원음이 없으면 건너뛴다.
     */
    private fun match(api: Server, code: String, token: String, dev: String, items: List<Utterance>, sp: Speakers) {
        val files = RawFile.of(filesDir, code)
        for (u in items) {
            val to = u.endedAt - 500 // 최종 결과는 말 끝 0.6초 뒤에 온다(11/13): 끝의 무음을 덜어 목소리만
            val from = maxOf(u.startedAt + LEAD_MS / 2, to - 9_900) // 서버는 0.5~10초를 받는다. 0.1초 묶음 단위로 잘려도 그 안에 들게
            if (!clipsAllowed) return // 그사이 동의를 껐으면(철회) 원음을 더 보내지 않는다
            val pcm = if (to - from < 600) null else clipFile(files, from..to)?.let { runCatching { it.cut(Live.seal(this), from, to) }.getOrNull() }
            if (pcm == null || pcm.size < RATE) { sp.done(u.seq); continue } // 원음이 없거나 짧음: 다시 하지 않음
            val r = try {
                // 구역이 틀렸을 수 있어(앞뒤 사람이 이어 말함) 그 줄에서 못 찾으면 줄 없이 한 번 더
                api.voiceMatch(code, token, u.seatZone?.plus(1), dev, u.seq, wav(pcm)).let { r ->
                    if (r.who == null && u.seatZone != null && clipsAllowed) api.voiceMatch(code, token, null, dev, u.seq, wav(pcm)) else r
                }
            } catch (e: ApiError) {
                if (e.status in listOf(400, 404, 409, 413)) { sp.done(u.seq); continue } else throw e // 403·5xx·끊김: 다음 차례에 이 발화부터
            }
            sp.set(u.seq, r); sp.done(u.seq)
            Log.i("GachitaCapture", "말한 사람 ${u.seq} 구역 ${u.seatZone ?: "모름"} ${if (r.who != null) "찾음" else "모름"} ${r.confidence}") // 이름·글자는 남기지 않는다
        }
    }

    private fun speakersOf(code: String): Speakers = speakers?.takeIf { it.trip == code } ?: Speakers(filesDir, code, Live.seal(this)).also { speakers = it; heardTick++ }

    /**
     * 출발 전 목소리 등록(T37, #65): 그 사람이 두 문장을 읽는 동안(10초) 수음 중인 모노 소리를 모아 그 사람의 토큰으로 올린다.
     * 기록 중(모두 동의)일 때만. 그 사이 받아 적힌 말은 보관함에, 소리는 원음에 남기지 않는다. 서버도 대조용 값만 둔다.
     */
    private fun enroll(p: Person) {
        val token = tokens[p.id] ?: return
        val code = s.trip?.code ?: return
        if (!CaptureService.running || muted || enrolling != null || Live.enroll != null) return // Gleo에 마이크를 넘긴 동안(T41)은 모을 소리가 없다
        val buf = java.io.ByteArrayOutputStream()
        val now = System.currentTimeMillis()
        Live.quiet = (now - 1_000)..(now + ENROLL_MS + 1_500)
        Live.enroll = buf
        enrolling = p; voiceNote = ""
        main.postDelayed({
            if (Live.enroll === buf) Live.enroll = null // 보통은 수음 스레드가 10초가 차서 이미 놓았다
            enrolling = null
            val pcm = buf.toByteArray()
            val url = server
            bg({ Server(url).voice(code, p.id, token, wav(pcm)) }) { r ->
                r.onSuccess {
                    voiced = voiced + p.id; prefs.edit().putString("voiced", "$voicedAt:" + voiced.joinToString(",")).apply()
                    voiceNote = "${p.name} 목소리를 등록했어요"
                }.onFailure { voiceNote = "${p.name} 목소리를 등록하지 못했어요 · ${reason(it)}" }
            }
        }, ENROLL_MS + 300)
    }

    /**
     * 화면에서 말한 사람을 고침(T37). 차 안에 남기고(부탁·화면, 대조가 덮지 않음) 서버 기록에도 보낸다(#65 PATCH, 올린 참가자의 토큰).
     * 고칠 수 있는 줄은 대조를 마친(곧 서버가 받은) 발화뿐이다. 보내지 못하면 차 안에만 남는다.
     */
    private fun fixSpeaker(u: Utterance, p: Person) {
        speakersOf(u.trip).set(u.seq, Speaker(p.id, 1.0, byPerson = true, sent = false)); heardTick++ // 서버에 남길 때까지 '보내는 중'
        s.trip?.takeIf { it.code == u.trip }?.let(::speakers) // 바로 보내고, 못 보내면 다음 조회마다 다시
    }

    /** 서버가 모르는 여행(48시간이 지나 지워짐): 기록을 멈추고 이 차의 사본(보관함·할 일)을 지운 뒤 처음 화면으로. */
    private fun forget(code: String) {
        val current = s.trip?.code == code
        if (current) newTrip() // 기록을 멈추고 처음 화면으로
        dropTrip(filesDir, code); Live.forget(code) // 새 여행을 만든 뒤 늦게 온 앞 여행의 404여도 그 사본은 지운다
        if (current) error = "서버에 없는 여행이라 이 차에 남은 기록도 지웠어요"
    }

    /** 기록 중이면 내비에 지금 위치를 물어 둔다. 발화에 붙인다(FIX_MS). 휴게소를 찾는 중이면 그 물음을 끊지 않게 묻지 않는다. */
    private fun locate() {
        if (!s.recording || offer?.stage == Offer.Stage.FINDING) return
        car.here { la, ln -> if (la != null && ln != null) Live.fix = Fix(la, ln, System.currentTimeMillis()) }
    }

    /** 켜기 직전에 기어를 다시 읽고, 이 차가 참가시킨 사람의 동의를 그 사람의 토큰으로 켠다. 서버에서 모두 동의한 뒤에만 '기록 중'. */
    private fun turnOn() {
        car.readGear { g ->
            s = s.withGear(g)
            s.blockOn()?.let { s = s.copy(note = it); return@readGear }
            val t = s.trip!!
            val url = server
            val mine = tokens
            s = s.copy(busy = true, note = "")
            bg({
                val api = Server(url)
                t.people.forEach { p -> mine[p.id]?.let { api.consent(t.code, p.id, true, it) } } // 폰으로 들어온 사람은 자기 폰에서
                api.trip(t.code)!!
            }) { r ->
                if (s.trip?.code != t.code) return@bg // 그사이 지운 여행이나 새 여행: 늦게 온 응답은 지금 세션(새 여행 만들기의 busy 등)을 건드리지 않는다
                r.onSuccess {
                    // 같은 여행이어도 보관 기한(48시간)이 지났으면 되살리지 않고 이 요청의 busy만 푼다
                    if (System.currentTimeMillis() - it.trip.createdAt > KEEP_MS) { s = s.copy(busy = false); return@onSuccess }
                    s = s.copy(busy = false).turnedOn(keep(it)); if (s.recording) car.speak("기록을 시작했어요")
                }
                    .onFailure { s = s.copy(busy = false, online = it is ApiError, note = "기록을 시작하지 못했어요 · ${reason(it)}") }
            }
        }
    }

    /** 끄기는 서버를 기다리지 않고 바로 멈춘다. 서버에는 refresh가 알린다. */
    private fun turnOff() {
        s = s.turnOff().copy(note = "") // 수음을 먼저 멈춘다(setter의 syncCapture)
        s.trip?.let { dropRawAll(it.code) } // 원음은 차에만 있으니 서버 확인을 기다리지 않고 바로 지운다(ADR-0007 철회 때 원음 삭제)
        car.speak("기록을 멈췄어요")
        refresh()
    }

    private fun newTrip() {
        prefs.edit().remove("trip").remove("tokens").commit()
        sweep(filesDir, Live.seal(this), System.currentTimeMillis()).forEach(Live::forget)
        tokens = emptyMap()
        s = Session(gear = s.gear)
        offer = null; todos = null; todoList = emptyList(); brief = null; speakers = null; voiced = emptySet()
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

    private fun todosOf(code: String): Todos = todos?.takeIf { it.trip == code } ?: Todos(filesDir, code, Live.seal(this)).also { todos = it; todoList = it.items }

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

    // ---- 동승 연결(T46, #195 계약) ----

    private fun scan() {
        rideNote = ""
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) scanning = true else askCamera.launch(Manifest.permission.CAMERA)
    }

    /** 읽은 QR의 사람을 고른 자리에 넣는다. 자리 충돌은 QR을 쓰지 않으므로 다른 자리로 다시 고를 수 있다. 동의는 그 사람의 폰에서만 켠다. */
    private fun seatRider(seat: Seat) {
        val t = s.trip ?: return
        val code = rideQr?.let(::rideCode) ?: return
        val url = server
        rideNote = "연결하고 있어요"
        bg({ Server(url).rideLink(t.code, code, seat) }) { r ->
            r.onSuccess { name ->
                rideQr = null; rideNote = "$name 님을 ${seat.label}에 넣었어요 · 폰에서 기록에 동의하면 함께 기록해요"
                Log.i(TAG, "동승 연결 ${seat.name}")
                refresh()
            }.onFailure { e ->
                Log.i(TAG, "동승 연결 못 함 ${(e as? ApiError)?.status ?: "연결"}")
                rideNote = when ((e as? ApiError)?.status) {
                    409 -> "자리가 찼거나 이미 연결한 QR이에요 · 다른 자리를 고르거나 폰에서 QR을 다시 띄워 주세요"
                    404 -> { rideQr = null; "QR이 만료됐어요 · 폰에서 QR을 다시 띄워 주세요" }
                    else -> "연결하지 못했어요 · ${reason(e)}"
                }
                refresh()
            }
        }
    }

    // ---- 숏폼 그 자리 재생(T43, #63 계약: GET /shortform, 클립은 참가자 토큰 머리말) ----

    /** 녹음에 동의한, 이 차가 참가시킨 사람의 토큰. 숏폼은 기록본처럼 동의한 참가자만 본다. */
    private fun viewer(): String? = s.trip?.people?.firstOrNull { it.consent && it.id in tokens }?.let { tokens[it.id] }

    private fun showShort() {
        val t = s.trip ?: return
        val tok = viewer() ?: run { shortNote = "기록에 동의한 사람만 볼 수 있어요"; return }
        val url = server
        shortNote = "숏폼을 받고 있어요"
        bg({ parseShort(Server(url).shortform(t.code, tok)) }) { r ->
            if (isDestroyed) return@bg
            r.onSuccess { sh ->
                if (sh.scenes.isEmpty()) { shortNote = "아직 숏폼으로 만들 장면 클립이 없어요"; return@bg }
                if (carStatus.restricted || handoff.state != Handoff.State.OFF) { shortNote = ""; return@bg }
                if (getSystemService(AudioManager::class.java).requestAudioFocus(playFocus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { shortNote = "지금은 소리를 낼 수 없어요"; return@bg }
                short = sh; shortNote = ""
                play(0)
            }.onFailure { shortNote = "숏폼을 받지 못했어요 · ${reason(it)}" }
        }
    }

    /** 장면 i의 클립을 받아 튼다. 끝나면 다음 장면, 마지막이면 닫는다. 트는 동안은 수음을 멈춰 재생 소리가 기록에 다시 들어가지 않게 한다. */
    private fun play(i: Int) {
        val sh = short ?: return
        val tok = viewer()
        val url = server
        val clip = sh.scenes.getOrNull(i)?.let { clipUrl(url, it.clip) }
        if (clip == null || tok == null || carStatus.restricted) return stopShort()
        player?.release(); player = null // 다음 장면을 받는 동안 지난 플레이어를 '멈춤'이 다시 틀지 않게
        shortFile?.delete(); shortFile = null
        shortAt = i; shortPos = 0.0; shortPaused = false
        CaptureService.hold(true)
        val gen = ++shortGen
        val f = File(cacheDir, "short-$gen.wav")
        bg({ Server(url).download(clip, tok, f) }) { r ->
            if (isDestroyed || gen != shortGen || short !== sh) { f.delete(); return@bg } // 그사이 닫혔거나 다른 장면
            r.exceptionOrNull()?.let { f.delete(); shortNote = "클립을 받지 못했어요 · ${reason(it)}"; return@bg stopShort() }
            shortFile = f
            val mp = MediaPlayer()
            runCatching { mp.setAudioAttributes(media); mp.setDataSource(f.path); mp.prepare(); mp.setOnCompletionListener { if (gen == shortGen) play(i + 1) }; mp.start() }
                .onFailure { Log.w(TAG, "클립 재생 실패", it); mp.release(); shortNote = "클립을 틀지 못했어요"; return@bg stopShort() }
            player = mp
            Log.i(TAG, "숏폼 장면 ${i + 1}/${sh.scenes.size} ${f.length()}바이트")
            main.removeCallbacks(shortTick); main.post(shortTick)
        }
    }

    private fun stopShort() {
        player?.release(); player = null
        shortGen++ // 받는 중인 클립은 끝나면 스스로 지운다
        main.removeCallbacks(shortTick)
        if (short != null) { // 연 숏폼이 있으면(첫 장면을 열기 전에 실패해도) 포커스와 수음을 돌려준다. hold(false)는 멈추지 않았으면 아무것도 안 함
            getSystemService(AudioManager::class.java).abandonAudioFocusRequest(playFocus)
            if (handoff.state == Handoff.State.OFF) CaptureService.hold(false)
            Log.i(TAG, "숏폼 닫음")
        }
        short = null; shortAt = -1
        shortFile?.delete(); shortFile = null // 받은 클립은 남기지 않는다
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

    // ---- 화면(T83, 시안: 피그마 '개편 · 차와 폰' C1~C7) ----
    // 칸의 자리와 크기를 고정하고 칸 안의 내용만 바꾼다. 카드가 생기고 사라져도 다른 칸이 밀리지 않는다(주행 중 화면은 움직이지 않아야 함, T11).
    // 넓은 창: 머리 줄 / 왼쪽 무대(기록 상태 · 초점 칸 · 부탁·할 일 수) / 오른쪽(좌석 지도 · 주차 중 도구 · 기록 동의).
    // 숏폼과 동승 연결은 주차 중에만, 왼쪽 무대 전체를 쓴다.

    /** 여행 만들기(C6): 같이 탈 가족을 캐릭터 카드로 고르고 'N명으로 여행 만들기'. 서버 주소는 화면에 두지 않고 디버그 실행 인자(--es server)로만 바꾼다. */
    @Composable
    private fun Setup() {
        val c = MaterialTheme.colorScheme
        Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            AppBar(TITLE, listening = false, *pills(online = null))
            Spacer(Modifier.height(8.dp))
            Text("누구랑 같이 타나요?", fontSize = 40.sp, fontWeight = FontWeight.Bold)
            Text("같이 타는 가족을 골라 주세요", color = c.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                FAMILY.forEach { m ->
                    val on = m.name in picked
                    MemberCard(m, on, Modifier.weight(1f)) { if (on) picked.remove(m.name) else picked.add(m.name) }
                }
            }
            Spacer(Modifier.weight(1f))
            Text(error, color = c.error, maxLines = 2) // 비어 있어도 자리를 둔다
            Button(::createTrip, Modifier.fillMaxWidth().height(96.dp), enabled = !s.busy && picked.isNotEmpty()) {
                Text(if (s.busy) "여행을 만들고 있어요" else "${picked.size}명으로 여행 만들기", fontSize = 30.sp, fontWeight = FontWeight.Bold)
            }
        }
    }

    /** 가족 한 사람(C6). 누르면 같이 탐·안 탐을 바꾼다(체크 상태라 화면 트리에 checked로 보인다). */
    @Composable
    private fun MemberCard(m: Member, on: Boolean, modifier: Modifier, toggle: () -> Unit) {
        val c = MaterialTheme.colorScheme
        Surface(
            checked = on, onCheckedChange = { toggle() }, modifier = modifier, shape = RoundedCornerShape(32.dp),
            color = if (on) c.primaryContainer else c.surface, border = BorderStroke(3.dp, if (on) c.onPrimaryContainer else c.outlineVariant),
        ) {
            Column(Modifier.padding(vertical = 28.dp, horizontal = 12.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Character(m.seat.ordinal, 112.dp)
                Text(m.name, fontSize = 30.sp, fontWeight = FontWeight.Bold, color = c.onSurface)
                Text(m.seat.label, color = c.onSurfaceVariant, maxLines = 1)
                Text(if (on) "✓ 같이 타요" else "안 타요", color = if (on) c.onPrimaryContainer else c.onSurfaceVariant)
            }
        }
    }

    /** 주행 제한 중에는 여행 만들기(가족 고르기)가 설정이라 가린다(T11, NO_SETUP). */
    @Composable
    private fun SetupLocked() {
        Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            AppBar(TITLE, listening = false)
            Spacer(Modifier.height(8.dp))
            Text("누구랑 같이 타나요?", fontSize = 40.sp, fontWeight = FontWeight.Bold)
            Card { Text("주차(P)한 뒤 여행을 만들 수 있어요", fontSize = 30.sp, fontWeight = FontWeight.Bold) }
        }
    }

    /** 머리 줄 알약: 주차 중이면 기어(C5·C6), 여행 중이면 서버 연결(C1). 주행 중 기어는 Pleos 주행 화면이 보인다. */
    private fun pills(online: Boolean?): Array<Pair<String, Boolean>> = listOfNotNull(
        carStatus.gear?.takeIf { !carStatus.restricted }?.let { "주차 중 · $it" to true },
        online?.let { if (it) "서버 연결됨" to true else "연결 끊김" to false },
    ).toTypedArray()

    /**
     * 여행 화면. 주행 제한 중(T11)에는 기록 상태, 받아 적은 말 두 줄, 일행, 부탁·할 일 수, 기록 동의(끄기만), 연결만 24sp 이상으로 보인다.
     * 1682 × 1210 창은 두 칸, 반쪽(약 841 × 1210)은 같은 칸을 위에서 아래로 쌓고 기록 동의를 아래에 붙인다(frontend/spec/car.md).
     */
    @Composable
    private fun TripScreen(t: Trip) {
        val parked = !carStatus.restricted
        BoxWithConstraints(Modifier.fillMaxSize().padding(32.dp)) {
            val wide = maxWidth >= 1200.dp
            Column(verticalArrangement = Arrangement.spacedBy(24.dp)) {
                AppBar(t.title.ifEmpty { "가족 여행" }, listening = s.recording && Live.mic == Mic.ON && !muted && handoff.state == Handoff.State.OFF, *pills(s.online))
                if (wide) {
                    Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(32.dp)) {
                        Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(24.dp)) {
                            if (takeover()) Takeover(t, Modifier.weight(1f)) else { StatusHero(t); Focus(t, Modifier.weight(1f)); Counts(t) }
                        }
                        Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(24.dp)) {
                            People(t, Modifier.weight(1f), fill = true)
                            if (parked) Tools(t)
                            Consent()
                        }
                    }
                } else {
                    // 한 칸: 넘치면 손으로 스크롤한다(자동 스크롤 없음). 주행 중에 누를 수 있는 유일한 조작(기록 동의 끄기)은 스크롤 밖 아래에 붙인다
                    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(24.dp)) {
                        if (takeover()) Takeover(t, Modifier.height(900.dp)) else { StatusHero(t); Focus(t, Modifier.height(360.dp)); Counts(t) }
                        People(t, compact = !parked)
                        if (parked) Tools(t)
                    }
                    Consent()
                }
            }
        }
    }

    /** 왼쪽 무대 전체를 쓰는 것: 숏폼 재생, 동승 연결(카메라·자리 고르기). 주차 중에만(제한이 걸리면 각자 닫는다). */
    private fun takeover() = !carStatus.restricted && ((short != null && shortAt >= 0) || scanning || rideQr != null)

    @Composable
    private fun Takeover(t: Trip, modifier: Modifier) {
        val sh = short
        if (sh != null && shortAt >= 0) ShortStage(sh, modifier) else RideStage(t, modifier)
    }

    private data class Status(val big: String, val sub: String, val bigColor: Color = Color.Unspecified, val strong: Boolean = false)

    @Composable
    private fun status(t: Trip): Status {
        val c = MaterialTheme.colorScheme
        return when {
            s.recording && muted -> Status("기록 멈춤", "Gleo로 멈췄어요 · 동의는 그대로예요")
            s.recording && shortAt >= 0 -> Status("기록 잠시 멈춤", "숏폼을 듣는 동안은 기록하지 않아요")
            s.recording && handoff.state != Handoff.State.OFF ->
                Status("기록 잠시 멈춤", if (handoff.state == Handoff.State.WAITING) "운전대 버튼을 누르세요" else "Gleo가 끝나면 다시 기록해요", strong = true)
            s.recording -> when (Live.mic) {
                Mic.ON -> Status("● 기록 중", Live.why.ifEmpty { "동의를 끄면 바로 멈춰요" }, c.error)
                Mic.BLOCKED -> Status("기록 멈춤", "마이크가 막혔어요 · 앱을 열어 두면 다시 기록해요", c.error)
                Mic.FAILED -> Status("기록 멈춤", Live.why, c.error)
                else -> Status("기록 준비", "기록을 시작하고 있어요")
            }
            s.waiting -> Status("기록 대기", "주차(P)하면 기록을 시작해요")
            else -> Status("기록 꺼짐", when {
                s.offPending -> "기록을 멈췄어요"
                t.people.any { it.consent } -> "모두 동의하면 다시 기록할 수 있어요"
                else -> "주차(P)한 뒤 대화 기록 동의를 켜면 기록해요"
            })
        }
    }

    /** 기록 상태(높이 고정). 큰 글 한 줄, 작은 글 한 줄, Gleo로 멈췄으면 오른쪽에 '다시 기록'. */
    @Composable
    private fun StatusHero(t: Trip) {
        val c = MaterialTheme.colorScheme
        val st = status(t)
        Card(statusTone(), Modifier.height(168.dp)) {
            Row(Modifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(st.big, fontSize = 48.sp, fontWeight = FontWeight.Bold, color = st.bigColor, maxLines = 1)
                    Text(st.sub, color = if (st.strong) c.onSurface else c.onSurfaceVariant, fontWeight = if (st.strong) FontWeight.Bold else null, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (s.recording && muted) Button({ mute(false); syncCapture() }, Modifier.heightIn(min = 72.dp)) { Text("다시 기록", fontSize = 26.sp) }
            }
        }
    }

    /** 이 차가 참가시킨 사람 가운데 아직 목소리를 등록하지 않은 사람(T37). 출발 전(받아 적은 말이 없을 때)에만 초점 칸에 띄운다. */
    private fun enrollShown(t: Trip) =
        !carStatus.restricted && s.recording && (enrolling != null || voiceNote.isNotEmpty() || (Live.count == 0 && t.people.any { it.id in s.ours && it.id !in voiced }))

    /** 초점 칸(크기 고정): 지금 가장 급한 것 하나만. 제안 > 도착 브리핑 > 목소리 등록 > 받아 적은 말. */
    @Composable
    private fun Focus(t: Trip, modifier: Modifier) {
        val o = offer?.takeIf { it.stage != Offer.Stage.FINDING }
        val b = brief?.takeIf { !carStatus.restricted } // 주행 중에는 목록을 띄우지 않는다(T40)
        when {
            o != null -> OfferCard(o, modifier)
            b != null -> BriefCard(b, modifier)
            enrollShown(t) -> EnrollCard(t, modifier)
            else -> Heard(t, modifier)
        }
    }

    /**
     * 일행 자리 지도. 칸은 차가 알려 준 좌석(CarStatus.seats)에서 만든다. 이름 아래에는 동의만 적는다.
     * compact(좁은 창 주행 중): 캐릭터를 줄이고 동의 줄을 빼서 부탁 수와 기록 동의가 한 화면에 들어오게 한다. fill이면 남은 높이 가운데에 둔다.
     */
    @Composable
    private fun People(t: Trip, modifier: Modifier = Modifier, compact: Boolean = false, fill: Boolean = false) {
        val c = MaterialTheme.colorScheme
        Card(modifier = modifier) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("일행 ${t.people.size}명", Modifier.weight(1f), fontSize = 30.sp, fontWeight = FontWeight.Bold)
                Text("차 앞쪽 ▲", color = c.onSurfaceVariant)
            }
            // 방금 받아 적은 말의 좌석 구역(T37)을 그 줄의 바탕으로, 말한 사람(대조·고침, T37)을 그 사람의 캐릭터로 보인다. 모르면 강조하지 않는다.
            heardTick // 말한 사람이 바뀌면 다시 그린다
            val last = Live.recent.lastOrNull()?.takeIf { s.recording }
            val map = @Composable {
                SeatMap(
                    t.people, last?.seatZone, highlight = last?.let { u -> speakers?.takeIf { it.trip == t.code }?.get(u.seq)?.who }, size = if (compact) 56.dp else if (fill) 96.dp else 80.dp, car = carStatus,
                    note = if (compact) null else { p -> if (p.consent) "동의" to c.tertiary else if (s.waitsFor(p)) "동의 대기" to c.secondary else "동의 전" to c.onSurfaceVariant },
                )
            }
            if (fill) Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) { map() } else map()
        }
    }

    /** 보관한 부탁 수와 도착해서 할 일 수(C1의 두 칸, 높이 고정). */
    @Composable
    private fun Counts(t: Trip) {
        val open = todoList.count { !it.done }
        Row(Modifier.fillMaxWidth().height(136.dp), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            Stat("보관한 부탁", if (t.heldRequests == 0) "없음" else "${t.heldRequests}건", Modifier.weight(1f))
            Stat("도착해서 할 일", if (open == 0) "없음" else "${open}건", Modifier.weight(1f))
        }
    }

    @Composable
    private fun Stat(label: String, value: String, modifier: Modifier) {
        Card(modifier = modifier.fillMaxHeight()) {
            Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(value, fontSize = 40.sp, fontWeight = FontWeight.Bold)
        }
    }

    /**
     * 받아 적은 말(C1). 주행 중에는 '방금 받아 적은 말' 두 줄(docs/emulator/README.md: 글자 24sp 이상, 자동 스크롤·움직이는 표시 없음).
     * 주차 중에는 '대화록': 이 차가 받아 적은 말 전체를 최신순으로 칸 안에서 손으로 넘겨 본다. 말한 사람 고치기(T37)는 최근 두 줄만.
     */
    @Composable
    private fun Heard(t: Trip, modifier: Modifier) {
        val c = MaterialTheme.colorScheme
        val parked = !carStatus.restricted
        heardTick // 말한 사람이 바뀌면 다시 그린다
        val lines = if (parked) remember(Live.count, Live.recent) { Live.box?.recent(Live.count).orEmpty() } else Live.recent
        Card(modifier = modifier) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (parked) "대화록" else "방금 받아 적은 말", Modifier.weight(1f), fontSize = 30.sp, fontWeight = FontWeight.Bold)
                Text("${Live.count}건", color = c.onSurfaceVariant)
            }
            if (lines.isEmpty()) Text("아직 받아 적은 말이 없어요", color = c.onSurfaceVariant)
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                lines.asReversed().forEachIndexed { i, u -> HeardLine(t, u, fix = parked && i < 2) }
            }
            if (parked && Live.pending > 0) Text("서버에 아직 보내지 못하고 이 차에 보관 중 ${Live.pending}건", color = c.onSurfaceVariant, fontSize = 20.sp, maxLines = 1)
        }
    }

    /** 한 줄: 말한 사람의 캐릭터(모르면 빈 동그라미), '시각 · 이름 · 앞줄', 그 말. */
    @OptIn(ExperimentalLayoutApi::class)
    @Composable
    private fun HeardLine(t: Trip, u: Utterance, fix: Boolean) {
        val c = MaterialTheme.colorScheme
        val sp = speakers?.takeIf { it.trip == t.code }?.get(u.seq)
        val who = sp?.who?.let { id -> t.people.firstOrNull { it.id == id } }
        val meta = listOfNotNull(
            SimpleDateFormat("HH:mm", Locale.KOREA).format(Date(u.startedAt)),
            who?.name ?: "누구?".takeIf { sp != null },
            u.seatZone?.let { if (it == 0) "앞줄" else "뒷줄" },
            "보내는 중".takeIf { sp?.byPerson == true && !sp.sent },
        ).joinToString(" · ")
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            if (who != null) Character(runCatching { Seat.valueOf(who.seat).ordinal }.getOrDefault(0), 56.dp)
            else Box(Modifier.size(56.dp).clip(CircleShape).background(c.surfaceVariant)) // 누가 말했는지 모름(빈자리 점선과 구별)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(meta, color = c.onSurfaceVariant)
                Text(u.text, fontSize = 28.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                // 대조를 마친 줄은 주차 중에 사람을 골라 고친다(T37): '모름'이든 이름이 틀렸든. 그 구역의 사람을 앞에 두되 모두 보인다(구역이 틀렸을 수 있음)
                if (sp != null && fix) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    val row = u.seatZone?.let { if (it == 0) "ROW_1" else "ROW_2" }
                    t.people.filter { it.id != sp.who }.sortedBy { if (row != null && it.seat.startsWith(row)) 0 else 1 }.forEach { p ->
                        OutlinedButton({ fixSpeaker(u, p) }, Modifier.heightIn(min = 56.dp)) { Text(p.name, fontSize = 20.sp) }
                    }
                }
            }
        }
    }

    /** 출발 전 목소리 등록(T37). 주차 중이고 기록 중일 때 초점 칸에. */
    @OptIn(ExperimentalLayoutApi::class)
    @Composable
    private fun EnrollCard(t: Trip, modifier: Modifier) {
        val todo = t.people.filter { it.id in s.ours && it.id !in voiced }
        val e = enrolling
        val c = MaterialTheme.colorScheme
        Card(modifier = modifier) {
            Text("출발 전 목소리 등록", fontSize = 30.sp, fontWeight = FontWeight.Bold)
            if (e != null) {
                Text("${e.name}, 아래 두 문장을 읽어 주세요")
                ENROLL_LINES.forEach { Text(it, fontSize = 30.sp, fontWeight = FontWeight.Bold) }
            } else if (todo.isNotEmpty()) {
                Text("누가 말했는지 알아보려고 한 사람씩 두 문장을 읽어요. 목소리는 대조용 값만 서버에 남아요", color = c.onSurfaceVariant, fontSize = 20.sp)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    todo.forEach { p -> OutlinedButton({ enroll(p) }, Modifier.heightIn(min = 64.dp)) { Text(p.name) } }
                }
            }
            if (voiceNote.isNotEmpty()) Text(voiceNote, color = c.onSurfaceVariant, fontSize = 20.sp)
        }
    }

    /** 도착 브리핑(T40): 장소의 미완료 할 일과 항목마다 '완료'. 받아 적은 말 그대로 보인다. 목록은 칸 안에서 넘긴다. */
    @Composable
    private fun BriefCard(b: Brief, modifier: Modifier) {
        val items = todoList.filter { !it.done && (b.place == null || it.place == b.place) }
        Card(Tone.Accent, modifier) {
            Text(if (b.place != null) "${b.place}에서 할 일" else "도착해서 할 일", fontSize = 36.sp, fontWeight = FontWeight.Bold)
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items.forEach { item ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        Text((if (b.place == null) "${item.place} · " else "") + item.text, Modifier.weight(1f))
                        OutlinedButton({ complete(item) }, Modifier.heightIn(min = 64.dp)) { Text("완료") }
                    }
                }
            }
            OutlinedButton({ brief = null }, Modifier.heightIn(min = 64.dp)) { Text("닫기") }
        }
    }

    /** 경유지 제안(T9, C2). 주행 중에도 한 번 누르는 큰 단추 둘만. 거리·시간은 그곳까지이고 들르면 늘어나는 시간이 아니다. */
    @Composable
    private fun OfferCard(o: Offer, modifier: Modifier) {
        val c = MaterialTheme.colorScheme
        Card(Tone.Accent, modifier) {
            when (o.stage) {
                Offer.Stage.ASKING -> {
                    Text("${o.stop?.spoken}에 들를까요?", fontSize = 44.sp, fontWeight = FontWeight.Bold)
                    Text(listOf(distanceLabel(o.meters, o.seconds), "부탁 ${o.requests.size}건").filter { it.isNotEmpty() }.joinToString(" · "), color = c.onSurfaceVariant)
                    Spacer(Modifier.weight(1f))
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        // 그린 뒤에 묶인 부탁이 빠지지 않게 누른 때의 제안으로 부른다
                        Button({ offer?.let(::accept) }, Modifier.weight(1f).height(88.dp)) { Text("경유지로 추가", fontSize = 28.sp) }
                        OutlinedButton({ offer?.let { later(it) } }, Modifier.weight(1f).height(88.dp)) { Text("나중에", fontSize = 28.sp) }
                    }
                }
                Offer.Stage.FINDING -> {}
                else -> Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically)) {
                    val (title, color, sub) = when (o.stage) {
                        Offer.Stage.ADDING -> Triple("내비에 경유지를 추가하고 있어요", Color.Unspecified, "${o.stop?.spoken}")
                        Offer.Stage.ADDED -> Triple("경유지를 추가했어요", c.tertiary, "${o.stop?.spoken} · 부탁 ${o.requests.size}건")
                        else -> Triple("경유지를 추가하지 못했어요", c.error, "부탁은 보관했어요")
                    }
                    Text(title, fontSize = 44.sp, fontWeight = FontWeight.Bold, color = color)
                    Text(sub, fontSize = 30.sp, color = c.onSurfaceVariant)
                }
            }
        }
    }

    /**
     * 대화 기록 동의(높이 고정). 주행 중에는 끄기만 한 번 누름으로 된다. Gleo는 단추로 부르지 않고, 기록 중에 호출어를 알아채면 저절로 마이크를 넘긴다(T41, heard()).
     * 안내 줄 자리에 동의 오류를 대신 보여 높이가 변하지 않는다.
     */
    @Composable
    private fun Consent() {
        val c = MaterialTheme.colorScheme
        val sub = s.note.ifEmpty { if (carStatus.restricted) "끄기는 주행 중에도 한 번에 돼요" else "기본값은 꺼짐 · 주차 중에만 켤 수 있어요" }
        Card(modifier = Modifier.height(144.dp)) {
            Row(Modifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("대화 기록 동의", fontSize = 30.sp, fontWeight = FontWeight.Bold)
                    Text(sub, color = if (s.note.isEmpty()) c.onSurfaceVariant else c.error, fontSize = if (carStatus.restricted) 24.sp else 20.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                Switch(s.switchOn, { if (it) turnOn() else turnOff() }, enabled = !s.busy && (s.switchOn || !carStatus.restricted)) // 주행 제한 중에는 끄기(한 번 누름)만
            }
        }
    }

    /**
     * 주차 중 도구(높이 고정): 동승자 연결(T46)·숏폼(T43)을 여는 단추, 여행 코드와 진단 한 줄(알림이 있으면 그 자리에), 새 여행·원음 지우기.
     * 주행 중에는 그리지 않는다(T11).
     */
    @Composable
    private fun Tools(t: Trip) {
        val c = MaterialTheme.colorScheme
        val free = freeSeats(t)
        val tool = ButtonDefaults.filledTonalButtonColors(containerColor = c.primaryContainer, contentColor = c.onPrimaryContainer)
        val note = rideNote.ifEmpty { shortNote }.ifEmpty { if (free.isEmpty()) "빈자리가 없어 동승자를 더 넣을 수 없어요" else "" }
        Card {
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                FilledTonalButton(::scan, Modifier.weight(1f).height(72.dp), enabled = free.isNotEmpty(), colors = tool) { Text("폰 QR 읽기") }
                FilledTonalButton(::showShort, Modifier.weight(1f).height(72.dp), enabled = shortNote != "숏폼을 받고 있어요" && handoff.state == Handoff.State.OFF, colors = tool) { Text("숏폼 보기") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("여행 코드 ${t.code}", color = c.onSurfaceVariant, fontSize = 20.sp)
                Text(note.ifEmpty { "기어 ${s.gear ?: "모름"} · 내비 ${if (carStatus.navi) "연결됨" else "연결 안 됨"} · 음성 ${if (carStatus.voice) "준비됨" else "준비 안 됨"}" },
                    color = if (note.isEmpty()) c.onSurfaceVariant else c.onSurface, fontSize = 20.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                OutlinedButton(::newTrip, Modifier.heightIn(min = 64.dp), enabled = !s.agreed && !s.switchOn && !s.busy) { Text("새 여행 만들기") }
                OutlinedButton(::dropRawNow, Modifier.heightIn(min = 64.dp)) { Text("이 차에 둔 원음 지우기") }
            }
        }
    }

    /** 기록 상태 머리의 바탕: 기록 중은 빨강 기운, Gleo로 멈춤·기다림·막힘은 노랑 기운, 꺼짐은 보통 카드. */
    private fun statusTone() = when {
        s.recording && (muted || handoff.state != Handoff.State.OFF) -> Tone.Wait // Gleo로 멈춤·잠시 멈춤(T41)
        s.recording && Live.mic == Mic.ON -> Tone.Rec
        s.recording && (Live.mic == Mic.BLOCKED || Live.mic == Mic.FAILED) || s.waiting -> Tone.Wait
        else -> Tone.Plain
    }

    /**
     * 숏폼(T43)을 왼쪽 무대 전체에(릴스·틱톡·쇼츠의 세로 화면처럼). 주차 중에만.
     * 위: 장면마다 한 칸인 진행 막대와 '2 / 6 · 장면 이름'. 아래 왼쪽: 말한 사람과 큰 자막. 아래 오른쪽: 세로 단추(멈춤·다음 장면·닫기).
     * 영상이 아니라 장면 클립 소리 + 자막 큐 + 말한 사람이라(#63) 바탕은 어둡게 두고 글을 크게 쓴다.
     */
    @Composable
    private fun ShortStage(sh: Short, modifier: Modifier) {
        val sc = sh.scenes[shortAt]
        val cue = cueAt(sc.cues, shortPos) ?: sc.cues.lastOrNull { shortPos >= it.start } ?: sc.cues.firstOrNull() // 줄 사이에도 앞 자막을 둔다(쇼츠처럼 비지 않게)
        val ink = Color(0xFFF4F1EC)
        val face = cue?.who?.let { name -> s.trip?.people?.firstOrNull { it.name == name } }?.let { p -> runCatching { Seat.valueOf(p.seat).ordinal }.getOrNull() }
        Box(modifier.fillMaxWidth().clip(RoundedCornerShape(32.dp)).background(Brush.verticalGradient(listOf(Color(0xFF1C3A2D), Color(0xFF12110F))))) {
            Column(Modifier.fillMaxWidth().padding(28.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    sh.scenes.forEachIndexed { i, scene ->
                        val f = when { i < shortAt -> 1f; i > shortAt -> 0f; else -> (shortPos / scene.seconds).toFloat().coerceIn(0f, 1f) }
                        Box(Modifier.weight(1f).height(6.dp).clip(CircleShape).background(ink.copy(alpha = 0.3f))) { Box(Modifier.fillMaxWidth(f).fillMaxHeight().background(ink)) }
                    }
                }
                Text("${shortAt + 1} / ${sh.scenes.size} · ${sc.label}", color = ink, fontSize = 28.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            // 가운데: 지금 말하는 사람(영상 자리). 이름을 못 붙인 줄은 가치타 마스코트
            Box(Modifier.align(Alignment.Center).padding(bottom = 200.dp)) { if (face != null) Character(face, 240.dp, ring = true) else Mascot(listening = true, size = 200.dp) }
            Column(Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(start = 32.dp, end = 152.dp, bottom = 40.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                if (!cue?.who.isNullOrEmpty()) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    if (face != null) Character(face, 72.dp, ring = true)
                    Text(cue!!.who, color = ink, fontSize = 30.sp, fontWeight = FontWeight.Bold)
                }
                Text(cue?.text ?: "", color = Color.White, fontSize = 48.sp, fontWeight = FontWeight.Bold, lineHeight = 60.sp, maxLines = 5, overflow = TextOverflow.Ellipsis)
            }
            Column(Modifier.align(Alignment.BottomEnd).padding(end = 24.dp, bottom = 40.dp), verticalArrangement = Arrangement.spacedBy(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                RailButton(if (shortPaused) "이어 듣기" else "멈춤", if (shortPaused) Glyph.PLAY else Glyph.PAUSE) {
                    player?.let { if (it.isPlaying) it.pause() else it.start(); shortPaused = !it.isPlaying }
                }
                RailButton("다음 장면", Glyph.NEXT) { play(shortAt + 1) } // 마지막 장면에서 누르면 닫힌다
                RailButton("닫기", Glyph.CLOSE, ::stopShort)
            }
        }
    }

    private enum class Glyph { PLAY, PAUSE, NEXT, CLOSE }

    /** 숏폼 오른쪽 세로 단추: 둥근 단추와 아래 이름(릴스의 오른쪽 줄). 그림은 Canvas로 그려 글꼴에 기대지 않는다. */
    @Composable
    private fun RailButton(label: String, glyph: Glyph, onClick: () -> Unit) {
        val ink = Color(0xFFF4F1EC)
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Surface(onClick = onClick, shape = CircleShape, color = Color.White.copy(alpha = 0.16f), modifier = Modifier.size(88.dp)) {
                Canvas(Modifier.padding(28.dp)) {
                    val w = size.width; val h = size.height; val stroke = Stroke(6.dp.toPx(), cap = StrokeCap.Round)
                    when (glyph) {
                        Glyph.PLAY -> drawPath(Path().apply { moveTo(w * 0.15f, 0f); lineTo(w, h / 2); lineTo(w * 0.15f, h); close() }, ink)
                        Glyph.PAUSE -> { drawRect(ink, Offset(w * 0.1f, 0f), Size(w * 0.28f, h)); drawRect(ink, Offset(w * 0.62f, 0f), Size(w * 0.28f, h)) }
                        Glyph.NEXT -> { drawPath(Path().apply { moveTo(0f, 0f); lineTo(w * 0.7f, h / 2); lineTo(0f, h); close() }, ink); drawRect(ink, Offset(w * 0.78f, 0f), Size(w * 0.2f, h)) }
                        Glyph.CLOSE -> { drawLine(ink, Offset(0f, 0f), Offset(w, h), stroke.width, StrokeCap.Round); drawLine(ink, Offset(w, 0f), Offset(0f, h), stroke.width, StrokeCap.Round) }
                    }
                }
            }
            Text(label, color = ink, fontSize = 20.sp)
        }
    }

    /** 동승 연결(T46)을 왼쪽 무대 전체에(C7): 카메라로 폰의 QR 읽기 → 읽으면 빈자리 고르기. 폰이 없는 아이는 여행 만들 때 손님으로 넣는다. */
    @OptIn(ExperimentalLayoutApi::class)
    @Composable
    private fun RideStage(t: Trip, modifier: Modifier) {
        val c = MaterialTheme.colorScheme
        Card(Tone.Accent, modifier) {
            Text("동승자 연결", fontSize = 36.sp, fontWeight = FontWeight.Bold)
            if (rideQr != null) {
                Pill("동승 연결 QR을 읽었어요")
                Text("어느 자리에 앉았나요?", fontSize = 30.sp, fontWeight = FontWeight.Bold)
                Text("빈자리를 눌러 주세요 · 기록 동의는 그 사람이 폰에서 직접 켜요", color = c.onSurfaceVariant)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    freeSeats(t).forEach { seat -> Button({ seatRider(seat) }, Modifier.heightIn(min = 88.dp), enabled = rideNote != "연결하고 있어요") { Text(seat.label, fontSize = 28.sp) } }
                }
                Spacer(Modifier.weight(1f))
                OutlinedButton({ rideQr = null; rideNote = "" }, Modifier.fillMaxWidth().height(72.dp)) { Text("취소") }
            } else {
                Text("폰의 동승 QR을 카메라에 보여 주세요", color = c.onSurfaceVariant)
                Scanner(Modifier.weight(1f).fillMaxWidth().clip(RoundedCornerShape(24.dp)))
                OutlinedButton({ scanning = false }, Modifier.fillMaxWidth().height(72.dp)) { Text("닫기") }
            }
            Text(rideNote, fontSize = 20.sp, maxLines = 1) // 비어 있어도 자리를 둔다
        }
    }

    /** 카메라 미리보기와 QR 읽기. 화면에서 빠지면(닫기, 주행 제한, 읽음) 카메라를 놓는다. */
    @Composable
    private fun Scanner(modifier: Modifier) {
        val cam = remember {
            QrCamera(this, onCode = { rideQr = it; scanning = false }, onFail = { rideNote = it; scanning = false })
        }
        DisposableEffect(cam) { onDispose { cam.stop() } }
        AndroidView({ ctx ->
            TextureView(ctx).apply {
                surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                    override fun onSurfaceTextureAvailable(st: SurfaceTexture, w: Int, h: Int) { cam.size()?.let { st.setDefaultBufferSize(it.width, it.height) }; cam.start(Surface(st)) }
                    override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) {}
                    override fun onSurfaceTextureDestroyed(st: SurfaceTexture) = true
                    override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
                }
            }
        }, modifier)
    }

    @Composable
    private fun Card(tone: Tone = Tone.Plain, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) = CarCard(tone, modifier, content)
}
