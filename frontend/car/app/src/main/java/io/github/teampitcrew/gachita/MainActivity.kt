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
import androidx.activity.compose.BackHandler
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors

private const val DEFAULT_SERVER = "https://gachita.mangowhois.ai" // 실서비스(T27). 로컬 서버는 디버그 빌드에서 '서버 주소'나 --es server로
private const val POLL_MS = 10_000L // 웹앱은 2초. 차에서는 주행 중 자원 기준(CPU 5% 미만)을 생각해 길게 둔다
private const val TITLE = "함께하는 여행"
private const val TAG = "GachitaAsk"
private const val RESULT_MS = 60_000L // 경유지 결과 카드를 보여 두는 시간
private const val GLEO_ARRIVAL = "GACHITA_ARRIVAL_TASKS" // 이전 판의 함수 이름(T40). 매니페스트에만 남아 있어 실패로 답한다
private const val GLEO_START = "GACHITA_START_RECORDING"
private const val GLEO_PAUSE = "GACHITA_PAUSE_RECORDING" // 같은 곳(T41)
private const val GLEO_RESUME = "GACHITA_RESUME_RECORDING"
private const val RESYNC_EVERY = 30 // 조회 30번(5분)마다, 그리고 끊겼다 다시 닿을 때 서버의 확인 순번을 다시 받는다(ADR-0014 2절). 5분마다는 서버에서 지운 글도 차 사본에 맞춘다(T69)
private const val MATCH_MAX = 20 // 한 차례에 대조할 발화 수. 밀린 것이 많아도 클립 올리기를 오래 막지 않게
private const val OFFER_MS = 30_000L // 제안에 답이 없으면 보관으로 되돌리는 시간. 그사이 휴게소를 지나칠 수 있어 길게 두지 않는다

class MainActivity : ComponentActivity() {
    private val io = Executors.newSingleThreadExecutor()
    private val stopsIo = Executors.newSingleThreadExecutor() // 휴게소 추천 전용: 늦은 DNS가 공용 io를 막지 않게(Astra #317 3차)
    private val recordingIo = Executors.newSingleThreadExecutor()
    private var cancelRecordingStart: (() -> Unit)? = null
    private val clipIo = Executors.newSingleThreadExecutor() // 장면 클립 올리기(T63). 동의 끄기 요청이 클립 묶음 뒤에 서지 않게 따로
    @Volatile private var clipsAllowed = false // 모두 동의했고 끄기 대기가 없음. 클립을 하나 올릴 때마다 본다
    private val main = Handler(Looper.getMainLooper())
    private lateinit var prefs: SharedPreferences
    // 이 차에 로그인한 계정 토큰(prefs "account"). Onboarding.token은 prefs를 읽는 getter라 Compose가 바뀐 줄 모른다 — 가입·로그인·로그아웃이
    // prefs를 바꾸면 이 상태가 따라가 오른쪽 위 얼굴·시작 화면·가족 흐름이 바로 다시 그려진다. (prefs는 리스너를 약하게 쥐니 필드로 둔다)
    private var account by mutableStateOf<String?>(null)
    private val accountWatch = SharedPreferences.OnSharedPreferenceChangeListener { _, key -> if (key == null || key == "account") account = onboarding.token }
    private lateinit var car: Car
    private lateinit var onboarding: Onboarding // 계정·온보딩 C01–C08(T142, Onboarding.kt)

    private var state by mutableStateOf(Session())

    /**
     * 화면 상태. 끄기 대기와 주차 중 시작 표시는 앱이 다시 켜져도 이어지게 바뀔 때마다 저장한다.
     * commit(): 끈 직후 프로세스가 죽어도 끄기 대기가 남게 디스크에 쓰고 돌아온다(개인정보 쪽 표시라 apply()의 비동기 쓰기를 쓰지 않음).
     */
    private var s: Session
        get() = state
        set(v) {
            if (v.offPending != state.offPending || v.started != state.started || v.withdrawn != state.withdrawn)
                prefs.edit().putBoolean("offPending", v.offPending).putBoolean("started", v.started).putStringSet("withdrawn", v.withdrawn).commit()
            state = v
            boardingCall?.let { request ->
                if (v.trip?.code != request.attempt.trip || v.trip?.status !in setOf("boarding", "parked") ||
                    v.trip?.people?.none { it.id == request.attempt.driver && it.seat == Seat.ROW_1_LEFT.name } != false) closeBoarding()
            }
            clipsAllowed = v.consented && !v.offPending // 끄면 남은 클립을 더 올리지 않는다
            if (transcriptOf != contentScope()) clearTranscript()
            syncTodoScope()
            syncCapture() // 동의가 빠졌으면 수음을 먼저 멈춘다
            v.trip?.let { t ->
                // 등록값은 그 사람의 동의가 꺼지면 서버가 지운다. 꺼졌다 10초 안에 다시 켜져 차가 못 봤어도 세대가 오르므로 세대가 바뀌면 다시 등록한다
                val gen = "${t.code}:${t.generation}"
                voiced.filter { id -> voicedAt == gen && t.people.any { it.id == id && it.consent } }.toSet().takeIf { it != voiced || voicedAt != gen }?.let {
                    voiced = it; voicedAt = gen; prefs.edit().putString("voiced", "$gen:" + it.joinToString(",")).apply()
                }
                speakersOf(t.code).see(t.generation)
                printsOf(t.code).let { vp ->
                    vp.see(t.generation) // 동의 세대가 바뀌면 대조 값 사본을 지운다(ADR-0023)
                    // 보관 시간(3시간 30분)이 지난 사본은 대조할 말이 없어도 지운다: 여행을 받을 때마다(10초 조회) 본다. 녹음을 멈췄거나 아무도 말하지 않아도 남지 않게
                    vp.expire(System.currentTimeMillis())
                    // 탑승자나 동의가 바뀌면(새로 탐, 폰에서 프로필로 참가) 다음 대조 전에 다시 받는다. 그 밖에는 받은 사본을 3시간 30분 쓴다
                    val who = t.code + t.people.joinToString { "${it.id}${it.consent}" }
                    if (who != printsFor) { printsFor = who; vp.fetchedAt = 0 }
                }
                val box = Live.outbox(this, t.code)
                if (box.see(t.generation, t.createdAt)) Live.show(box) // 동의 세대가 오르면 옛 세대 발화의 글을 지운다
                if (v.consented) Live.rawGen = box.generation // 원음은 모두 동의한 세대로만 남긴다(T63)
                if ("${t.code}:${box.generation}" != rawSeen) { rawSeen = "${t.code}:${box.generation}"; dropRaw(filesDir, t.code, below = box.generation) } // 옛 세대의 원음은 지운다
            }
            if (v.autoStart) main.post(::autoRecord) // 모두 동의한 채 주행으로 바뀌면 버튼 없이 녹음(C03·C13)
        }
    private enum class Destination(val label: String) { RIDE("함께 타는 중"), CONVERSATION("대화 기록"), SHORTS("콘텐츠 기록") } // 콘텐츠 기록은 K3 전까지 쇼츠 화면
    private var destination by mutableStateOf(Destination.RIDE)
    // 가족·동승 그룹(흐름 F2, Family.kt). 토큰은 차 로그인(흐름 F1, Onboarding.token). 디버그 실행 인자 --es profileToken이 있으면 그것을 앞세운다(시험용).
    private var familyOpen by mutableStateOf(false)
    private var profileToken by mutableStateOf<String?>(null)
    private var shortStudioActive = false
    private var retentionMs: Long? = null // null은 무기한. 디버그 keepMs 인자가 있을 때만 만료 시험을 한다.
    private var boarding by mutableStateOf(BoardingState())
    private var boardingRequest = 0
    private data class ContentScope(val code: String, val generation: Int, val token: String)
    private var transcriptOf: ContentScope? = null
    private var transcript by mutableStateOf(emptyList<TranscriptLine>())
    private var transcriptAsks by mutableStateOf(emptySet<Pair<String, Int>>()) // 서버 할 일이 나온 줄(C44 '○○의 부탁')
    private var transcriptPlaces by mutableStateOf(emptyList<TripPlace>()) // 기록본에 실린 여행 장소(A3). 없으면 머리에 시각만
    private var afterStart by mutableStateOf<AfterStep?>(null) // 여행 마무리·장면 고르기(C22–C32, F5). null이면 콘텐츠 기록은 쇼츠 화면
    private var shortsVisit by mutableIntStateOf(0) // C33으로 들어올 때마다 하나씩: 콘텐츠 기록을 새로 그려 다시 읽고 갤러리부터(같은 탭을 다시 눌러도)
    private var wrapWhenParked = false // 주행 중 ■로 여행을 마쳤다 — 주차하면 C22
    private var menuGroup by mutableStateOf<String?>(null) // 프로필 메뉴 그룹 칸의 이름(가족 그룹, GET /api/groups)
    private var autoFailed = "" // 자동 시작이 실패한 여행·세대·판. 서버 여행이 바뀔 때만 다시 시도해 실패가 되풀이되지 않게
    private var departing = false // 주행 알림(PATCH driving)이 통신 줄에 있음
    private var transcriptLoading by mutableStateOf(false)
    private var transcriptNote by mutableStateOf("")
    private var transcriptRequest = 0
    private var carStatus by mutableStateOf(CarStatus())
    private var server by mutableStateOf(DEFAULT_SERVER)
    private var error by mutableStateOf("") // 여행을 못 만들었거나 이 차의 기록을 지운 까닭. 여행이 없을 때 알림으로 잠깐 보인다
    private var offer by mutableStateOf<Offer?>(null) // 지금 보이는 경유지 제안(T9)
    private var debug = false
    private var pendingRoute: List<String>? = null // 내비에 붙으면 보낼 목적지(디버그 인자)
    private var pendingStops: List<Place> = emptyList() // 그 목적지 앞에 들를 곳(디버그 인자 --es stops, 시연 T150)
    private var etaSeen = "" // 마지막으로 로그에 남긴 다음 장소·남은 시간(디버그)
    private var approachLimit = APPROACH_SECONDS // 도착 전 카드를 띄울 남은 시간(초). 디버그 인자 --ei approachSeconds로만 바꾼다(시연 T150)
    private var offers = 0L // 제안 번호. 늦게 온 콜백이 다른 제안을 건드리지 않게
    private var todoState by mutableStateOf(SharedTodoState())
    private var todosRequestedAt = 0L
    private var arrivalParking = ArrivalParkingGate()
    @Volatile private var arrivalRequest = 0
    private var arrivalLoading by mutableStateOf(false)
    private var arrivalNote by mutableStateOf("")
    private var clipping = false // 장면 클립을 올리는 중(T63)
    private var rawSeen = "" // 옛 세대 원음을 지운 여행·세대. 세대가 바뀔 때만 파일 목록을 본다
    private var speakers: Speakers? = null // 지금 여행의 발화별 말한 사람(T37)
    private var prints: VoicePrints? = null // 지금 여행 탑승자의 목소리 대조 값 사본(ADR-0023)
    private var printsFor = "" // 사본을 받을 때의 탑승자와 동의
    // 서버에서 여행(동의)을 마지막으로 확인한 시각.
    // ponytail: 앱을 켠 때부터 센다(저장하지 않음). 끊긴 채 앱을 다시 켜면 5분을 새로 얻는다 — 그게 문제가 되면 prefs에 둔다
    private var consentSeenAt = System.currentTimeMillis()
    private var matching = false // 대조·고침 보내기가 clipIo에 있음
    private var heardTick by mutableStateOf(0) // 말한 사람이 바뀌면 받아 적은 말 카드를 다시 그린다
    /** 이 차에서 목소리를 등록한 참가자. 그 사람의 동의가 꺼지면 서버가 등록값을 지우므로 여기서도 뺀다(#65). */
    private var voiced by mutableStateOf(emptySet<String>())
    private var voicedAt = "" // voiced가 맞는 여행·동의 세대
    private var clipsAfter = 0L // 다시 해도 되는 실패(403·503·끊김) 뒤에는 이때까지 쉰다. 큰 원음 파일을 10초마다 다시 읽지 않게
    private var carTodos: Pair<String, List<TodoAction>> = "" to emptyList()
    /**
     * 할 일은 차가 자기 보관함의 발화로 도출하고(T144, TodoActions.kt), 서버 목록에서는 상태·버전과 차에 없는 것(폰 입력·교정본)만 받는다.
     * 참가자 동의가 없거나 보관함의 동의 세대가 서버 목록의 세대와 다르면 차 결과를 쓰지 않는다. 상태 바꾸기는 그대로 PATCH /todos/{id}.
     */
    private val todoList: List<SharedTodo> get() {
        val scope = todoState.scope ?: return emptyList()
        val box = Live.box?.takeIf { it.trip == scope.trip && it.generation == scope.generation } ?: return todoState.items
        val key = "${box.trip}:${box.generation}:${Live.count}" // Live.count는 화면 상태라 새 발화가 들어오면 다시 그린다
        if (carTodos.first != key) carTodos = key to deriveActionTodos(box.lines().map { TodoLine("car", it.seq, it.startedAt, it.text) })
        return withCarTodos(carTodos.second, todoState.items)
    }
    /** 보이고 있는 도착 브리핑(C20). 주차해 주행 제한이 풀렸을 때만 그린다. */
    private data class Brief(val place: String, val arrivalItems: List<SharedTodo>? = null, val final: Boolean = false)
    private var brief by mutableStateOf<Brief?>(null)
    private var nextPlaceName: String? = null // 내비의 다음 도착지 이름(거리와 상관없이 마지막으로 읽은 것). 그곳에 묶인 부탁은 휴게소를 제안하지 않는다
    private var near by mutableStateOf<Approach?>(null) // 도착 전 브리핑(C19·finalNear). 주행 중 조회마다 내비 남은 시간으로 바꾸고 주차하면 지운다
    private var f4Mock by mutableStateOf<String?>(null) // mock: 디버그 빌드의 --es f4 …(F4 화면 확인용 시연 데이터, Arrival.kt F4Mock)
    private var appVisible by mutableStateOf(false) // onStart ~ onStop
    private var resumed = false // 우리 화면이 앞: 마이크 서비스는 이때만 시작할 수 있다(T10)
    private var askedMic = false
    private lateinit var handoff: Handoff // Gleo와 마이크 주고받기(T41). 프로세스에 하나(Handoff.of)
    /** Gleo로 '기록 멈추기'를 부름(T41). 동의는 그대로 두고 수음만 멈춘다. 앱이 다시 켜져도 멋대로 다시 기록하지 않게 저장한다. */
    private var muted by mutableStateOf(false)
    private val boardingIo = Executors.newSingleThreadExecutor()
    private data class BoardingRequest(val attempt: BoardingInviteAttempt, val token: String, val call: BoardingInviteCall = BoardingInviteCall())
    private var boardingCall: BoardingRequest? = null
    private lateinit var device: String // 보관함의 기기 값. 설치 단위(ADR-0014의 device)
    /** 이 차가 참가시킨 사람의 참가자 토큰(id → 토큰). 그 사람의 동의 켜기와 발화 올리기에 쓴다(T68). 참가할 때 한 번만 온다. */
    private var tokens: Map<String, String> = emptyMap()
    private var refreshing = false
    private var placeLog: PlaceLog? = null // 지금 여행의 장소 기록(T131)
    private var placing = false // 장소 올리기가 통신 줄에 있음
    private var uploading = false // 올리기가 통신 줄에 있음. 느린 길에서 조회마다 쌓여 동의 확인을 밀어내지 않게

    /** 화면이 보이는 동안, 그리고 수음 중이면 화면 뒤에서도 조회해 폰에서 끈 동의를 반영한다. */
    private val tick = object : Runnable {
        private var n = 0
        override fun run() {
            val every = ++n % RESYNC_EVERY == 0
            if (every && retentionMs != null) expire()
            refresh(resync = every || !s.online, prune = every); locate(); approaching(); depart()
            if (destination == Destination.CONVERSATION) loadTranscript()
            if (appVisible || s.recording) main.postDelayed(this, if (boarding.page == BoardingPage.QR) 2_000L else POLL_MS)
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
        if (shortStudioActive || destination == Destination.SHORTS) {
            CaptureService.hold(true) // 이미 있는 서비스도 재생 중에는 멈춘 상태를 유지한다.
            return // onResume이 Compose 활성 콜백보다 먼저 와도 쇼츠 탭에서는 새 수음을 시작하지 않는다.
        }
        if (CaptureService.running || !resumed || Live.mic == Mic.FAILED) return
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            if (!askedMic) { askedMic = true; askMic.launch(arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS)) }
            else Live.set(Mic.FAILED, "마이크 권한이 없어 기록할 수 없어요")
            return
        }
        CaptureService.start(this, code)
    }

    private fun shortStudioActiveChanged(active: Boolean) {
        shortStudioActive = active
        // 같은 Compose 갱신에서 Studio가 교체되면 새 소유자가 먼저 활성화된 뒤 재개 여부를 판단한다.
        if (!active) main.post { if (!isDestroyed) syncCapture() }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences("car", MODE_PRIVATE)
        handoff = Handoff.of(this) // 화면이 다시 만들어져도 넘긴 상태를 이어받는다
        cacheDir.listFiles { f -> f.name.startsWith("short") }?.forEach { it.deleteRecursively() } // 중단된 영상 생성 캐시(ShortVideoExport)와 이전 판의 미리듣기 파일만 정리합니다.
        muted = prefs.getBoolean("muted", false)
        // 실행 인자(--es server, --ei widthDp, --es route)는 디버그 빌드에서만 받는다. 밖에서 연 화면이 서버 주소를 바꾸지 못하게
        debug = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (debug) intent.getStringExtra("server")?.let { prefs.edit().putString("server", it).apply() }
        if (debug) { profileToken = intent.getStringExtra("profileToken")?.takeIf { it.isNotBlank() }; familyOpen = intent.getBooleanExtra("family", false) }
        server = prefs.getString("server", null) ?: DEFAULT_SERVER
        device = prefs.getString("device", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("device", it).apply() }
        onboarding = Onboarding(this, prefs) { server }
        account = onboarding.token
        prefs.registerOnSharedPreferenceChangeListener(accountWatch)
        if (debug && !intent.getBooleanExtra("onboarding", true)) onboarding.skipForDebug() // --ez onboarding false: 처음 화면을 가족 흐름(F2)으로 본다
        // 기본값은 무기한. --el keepMs를 명시한 디버그 빌드에서만 시간에 따른 정리를 시험한다.
        val now = System.currentTimeMillis()
        retentionMs = if (debug && intent.hasExtra("keepMs")) intent.getLongExtra("keepMs", -1).takeIf { it >= 0 } else null
        sweep(filesDir, Live.seal(this), now, retentionMs).forEach(Live::forget)
        // 여행과 참가자 토큰은 암호화한다. 열리지 않거나 명시한 디버그 시험 기간이 지났으면 없는 것으로 다룬다.
        fun unsealed(k: String) = prefs.getString(k, null)?.let { runCatching { Live.seal(this).unline(it) }.getOrNull() }
        val saved = unsealed("trip")?.takeIf { j -> runCatching { !retentionExpired(parseTrip(j).createdAt, now, retentionMs) }.getOrDefault(false) }
        if (saved == null) prefs.edit().remove("trip").remove("tokens").commit()
        tokens = unsealed("tokens")?.let { j -> JSONObject(j).let { o -> o.keys().asSequence().associateWith { o.getString(it) } } }.orEmpty()
        // 앱을 다시 켜도, 서버에 닿지 않아도 마지막으로 받은 여행과 끄기 대기, 받아 적은 말과 순번을 이어 보여 준다
        prefs.getString("voiced", null)?.split(":")?.takeIf { it.size == 3 }?.let { (code, gen, ids) -> voicedAt = "$code:$gen"; voiced = ids.split(",").filter { it.isNotEmpty() }.toSet() }
        s = Session.restore(saved, prefs.getBoolean("offPending", false), prefs.getBoolean("started", false), tokens.keys, prefs.getStringSet("withdrawn", emptySet()).orEmpty())
        if (s.offPending) s.trip?.let { dropRawAll(it.code) } // 끈 뒤 지우기 전에 앱이 꺼졌으면 마저 지운다
        car = Car(this) {
            val previousCar = carStatus
            carStatus = it
            if (previousCar.gear != it.gear || previousCar.restricted != it.restricted || previousCar.naviEvent != it.naviEvent) {
                if (arrivalLoading) arrivalNote = "차량 상태가 바뀌어 도착 확인을 멈췄어요"
                arrivalRequest++; arrivalLoading = false
                if (it.gear != "P" || it.restricted) { brief = null; arrivalNote = "" } // 도착 확인을 못 한 까닭은 주차한 동안만 보인다
                if (!it.restricted) near = null // 주차하면 도착 전 카드는 끝(도착 브리핑이 이어 받음)
            }
            if (it.restricted) onboarding.stopRecording() // 온보딩은 주차 중에만(목소리 녹음도 멈춤)
            // 주행 중에도 대화 기록은 읽기만으로 보인다(시안 2026:2308·2358, T11 완화). 콘텐츠 기록과 그룹 바꾸기는 주차 중에만
            if (it.restricted) { familyOpen = false; if (destination == Destination.SHORTS) destination = Destination.RIDE }
            // 주행 중 ■(녹화 종료)로 마친 여행은 주차하면 여행 마무리(C22)를 연다(콘텐츠 기록은 주차 중에만, T11)
            if (!it.restricted && wrapWhenParked) { wrapWhenParked = false; closeBoarding(); afterStart = AfterStep.UPLOAD; destination = Destination.SHORTS }
            if (it.restricted || it.gear != "P") closeBoarding() // 주행 제한·기어 변경은 QR을 즉시 가리고 초대를 폐기한다
            s = s.withGear(it.gear)
            if (previousCar.gear != it.gear) depart()
            val (parking, arrived) = arrivalParking.observe(it.gear, it.restricted)
            arrivalParking = parking
            if (arrived) arrive()
            routeIfReady()
        }
        car.start()
        Live.onHeard = ::heard
        syncTodoScope()
        routeFrom(intent)
        if (savedInstanceState == null) gleo(intent) // 다시 만들어진 화면이 지난 호출에 또 답하지 않게
        setContent {
            GachitaTheme {
                // ponytail: --ei widthDp 841은 창을 나누지 않고 반쪽 너비만 흉내 낸다(e2e.py). 실제 반쪽 창은 Pleos 창 바(⋮)로 나눈다(README)
                val w = if (debug) intent.getIntExtra("widthDp", 0) else 0
                Surface(if (w > 0) Modifier.fillMaxHeight().width(w.dp) else Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    // mock: --es f4 …이면 저장된 여행 대신 시안의 '강릉 가족 여행'(F4Mock)을 띄운다(디버그 빌드)
                    val t = f4Mock?.let { Trip("F4DEMO", "강릉 가족 여행", "driving", F4Mock.people, 0, 1) } ?: s.trip
                    // 오른쪽 위 '내 얼굴'은 모든 화면에 하나(TripHeader). 로그인 뒤에는 프로필 메뉴, 로그인 전에는 기본 캐릭터 얼굴 → 로그인 / 계정 만들기(C02)
                    val signedIn = (profileToken ?: account) != null
                    val me = Me(if (signedIn) charDrawable(onboarding.character) else R.drawable.char_basic) { shell, face ->
                        if (signedIn) { menuShell = shell; menuFace = face; profileMenu = true }
                        else { familyOpen = false; if (!onboarding.showing) onboarding.reopen(); onboarding.go(OnboardStep.SIGNUP) }
                    }
                    BackHandler(profileMenu || logoutAsk) { profileMenu = false; logoutAsk = false }
                    CompositionLocalProvider(LocalMe provides me) {
                        Box(Modifier.fillMaxSize()) {
                            // 여행이 없고 온보딩을 마쳤으면 주차 중 처음 화면은 가족 흐름(C16 groups·C43 → '이 가족과 출발'). 닫아도 같은 화면에 남는다
                            // 계정이 없으면 가족 흐름 대신 시작 화면(C01·C02) — 토큰 없는 가족 흐름은 그리지 않는다
                            val family = !carStatus.restricted && signedIn && (familyOpen || t == null && !onboarding.showing)
                            when {
                                // 로그아웃(2220:5864) → C01: 여행이 남아 있어도 계정이 없으면 시작 화면부터
                                !signedIn && onboarding.showing -> OnboardingScreen(onboarding, driving = carStatus.restricted) { familyOpen = true }
                                // 프로필 메뉴의 '동승 그룹 변경'·'좌석 배정'도 가족 흐름(C16 groups·C16B)으로 연다. 주차 중에만
                                family -> FamilyFlow(server, profileToken ?: account, onClose = { familyOpen = false },
                                    onStart = ::startGroupTrip, jump = familyJump, onJumped = { familyJump = null },
                                    // 가족 화면 위 탭(C14·C15·C16·C16 guestInvite·C16L·C43): 대화 기록 → C44, 콘텐츠 기록 → C33. 둘 다 여행 단위라 여행이 없으면 그 자리에
                                    onTab = { i -> if (t != null) { familyOpen = false; closeBoarding(); afterStart = null; destination = if (i == 1) Destination.CONVERSATION else Destination.SHORTS; shortsVisit++ } })
                                t != null -> TripScreen(t)
                                carStatus.restricted -> OnboardingScreen(onboarding, driving = true) {} // 주행 중 여행이 없으면 시작 화면(C01)만, 단추는 잠근다(T11)
                                else -> OnboardingScreen(onboarding) { familyOpen = true } // C08 '가족 그룹 만들기' → 가족 흐름(F2)
                            }
                            if (t == null) CarToast(error)
                            LaunchedEffect(error) { if (error.isNotEmpty()) { kotlinx.coroutines.delay(5_000); error = "" } }
                            if (profileMenu) MenuOverlay(t)
                            if (logoutAsk) LogoutConfirm(onCancel = { logoutAsk = false }, onLogout = { logoutAsk = false; familyOpen = false; logout() })
                        }
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); routeFrom(intent); gleo(intent) }

    /** 시연·E2E: --es route "위도,경도,이름"으로 내비에 목적지를 넣는다(디버그 빌드). 실제로는 운전자가 내비에서 정한다. */
    private fun routeFrom(i: Intent?) {
        if (debug && i?.hasExtra("route") == true) pendingStops = demoStops(i.getStringExtra("stops")) // 경로마다 새로(없으면 빈 목록)
        // 에뮬레이터 GPS는 움직이지 않아 남은 시간이 줄지 않는다. 시연 경로가 길로 5분을 넘으면 이 값으로 카드를 띄운다(디버그 빌드만)
        if (debug && i?.hasExtra("approachSeconds") == true) approachLimit = i.getIntExtra("approachSeconds", APPROACH_SECONDS).coerceIn(1, 3600)
        if (debug) pendingRoute = i?.getStringExtra("route")?.split(",")?.takeIf { it.size == 3 } ?: pendingRoute
        // mock: F4 화면 확인용 시연 데이터(near·nearPaused·finalNear·finalPaused·mart·final, 빈 값이면 끔). 디버그 빌드에서만
        if (debug && i?.hasExtra("f4") == true) f4Mock = i.getStringExtra("f4")?.takeIf { it.isNotBlank() }
        routeIfReady()
    }

    private fun routeIfReady() {
        val (la, ln, name) = pendingRoute?.takeIf { carStatus.navi } ?: return
        pendingRoute = null
        val stops = pendingStops.also { pendingStops = emptyList() }
        val sent = car.route(Place(la.toDouble(), ln.toDouble(), name), stops)
        Log.i(TAG, "경로 요청 ${name} · 경유 ${stops.size}곳${stops.joinToString("") { " ${it.name}" }} · ${if (sent) "보냄" else "못 보냄"}") // 시연·E2E(디버그 인자)
    }

    override fun onStart() { super.onStart(); appVisible = true; main.removeCallbacks(tick); main.post(tick) }
    override fun onStop() {
        appVisible = false; arrivalRequest++; arrivalLoading = false; arrivalNote = ""
        todoState = todoState.copy(sequence = todoState.sequence + 1, loading = false)
        closeBoarding(); super.onStop()
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        if (Live.mic == Mic.FAILED) Live.set(Mic.OFF) // 앱을 다시 열면 한 번 더 시도한다
        syncCapture()
    }

    override fun onPause() { resumed = false; super.onPause() }

    override fun onDestroy() {
        prefs.unregisterOnSharedPreferenceChangeListener(accountWatch)
        closeBoarding()
        onboarding.close()
        boardingIo.shutdown() // 발급 중 닫힌 요청은 같은 실행기에서 초대를 폐기하고 끝난다
        cancelRecordingStart?.invoke()
        recordingIo.shutdownNow()
        main.removeCallbacksAndMessages(null) // 조회, 제안 시간 초과, 결과 카드 닫기
        if (Live.onHeard == ::heard) Live.onHeard = null
        if (!isChangingConfigurations) { handoff.stop(); CaptureService.stop(this) } // 동의를 확인할 화면이 없어지면 수음도 멈춘다
        car.stop(); io.shutdown(); stopsIo.shutdownNow(); clipIo.shutdownNow(); super.onDestroy()
    }

    /** 통신은 한 줄로 차례대로 돌리고 결과만 메인 스레드로 돌려받는다. */
    private fun <T> bg(work: () -> T, done: (Result<T>) -> Unit) {
        if (!io.isShutdown) io.execute { val r = runCatching(work); main.post { done(r) } }
    }

    private fun keep(got: Server.Got): Trip { prefs.edit().putString("trip", Live.seal(this).line(got.json)).apply(); return got.trip }

    private fun reason(e: Throwable) = failureText(e)

    /** '이 가족과 출발'(C13): 그룹의 저장된 자리·각자 동의로 여행을 만들고, 이 차가 맡을 참가자 토큰(나와 내 아이)을 받는다(T133). */
    private fun startGroupTrip(groupId: String) {
        val token = profileToken ?: onboarding.token ?: return
        val url = server
        s = s.copy(busy = true); error = ""
        bg({
            val api = Server(url)
            val (code, mine) = api.groupTrip(token, groupId, TITLE)
            api.trip(code)!! to mine
        }) { r ->
            r.onSuccess { (got, mine) ->
                tokens = mine
                prefs.edit().putString("tokens", Live.seal(this).line(JSONObject(mine).toString())).commit() // 다시 받을 수 없는 값이라 디스크에 쓰고 돌아온다
                // C16A·C43 '출발' → C17 함께 타는 중(앞 여행의 탭이 대화 기록·콘텐츠 기록이어도). 출발을 누른 것이 녹음 시작이라(시안 C17은 이미 기록 중)
                // 모두 동의했으면 주차 중에 바로 녹음한다. 동의가 빠진 사람이 있으면 C17이 동의를 기다리고, 모이면 D로 나갈 때 자동 시작(autoRecord).
                familyOpen = false; closeBoarding(); afterStart = null; destination = Destination.RIDE
                s = Session(gear = s.gear, ours = mine.keys).withTrip(keep(got))
                if (s.agreed) startRecording()
            }
                .onFailure { s = s.copy(busy = false); error = "여행을 만들지 못했어요 · ${reason(it)}" }
        }
    }

    /**
     * 최신 여행을 묻는다. 끄기를 서버에 아직 못 알렸으면 먼저 다시 보낸다. 서버에서 여행이 삭제되면 차 안 사본도 지운다.
     * resync면 보낼 발화가 없어도 서버의 확인 순번을 다시 받는다(서버 DB가 백업에서 되살아나 내려갔으면 그 뒤부터 다시 보냄).
     * prune이면 이어서 참가자가 서버에서 지운 글을 차 사본에서도 지운다(T69). ponytail: 이 기기 발화 전체 목록을 받음. 순번만 주는 길이 생기면 바꾼다
     */
    private fun refresh(resync: Boolean = false, prune: Boolean = false) {
        if (refreshing) return
        val t = s.trip ?: return
        refreshing = true
        val off = s.offTargets
        val v = s.pollVersion
        val url = server
        bg({
            val api = Server(url)
            off.forEach { api.consent(t.code, it, false) }
            api.trip(t.code, v)
        }) { r ->
            refreshing = false
            r.onSuccess { got ->
                if (s.trip?.code != t.code) return@onSuccess // 그사이 삭제된 여행이나 새 여행: 늦게 온 응답으로 되살리지 않는다
                val wasWithdrawing = s.offPending
                s = (if (got == null) s.copy(online = true) else s.withTrip(keep(got))).polled()
                if (wasWithdrawing && !s.offPending) s = s.copy(note = "동의를 철회했어요. 다시 녹음하려면 각자의 동의가 필요해요")
                consentSeenAt = System.currentTimeMillis()
                upload(t, resync, prune) // 받은 여행의 동의 세대를 보관함에 반영한(철회면 글을 지운) 뒤에만 올린다
                speakers(t) // 올릴 새 발화가 없어도 밀린 대조와 고침을 잇는다
                s.trip?.let(::clips)
                s.trip?.let(::fullAudio)
                loadTodos()
                s.trip?.let(::places)
            }
                .onFailure {
                    if (it is Gone) forget(t.code) else s = s.pollFailed(it) // 조회를 못 하면 이번에는 올리지 않는다
                    // 끊김이든 서버 오류든 최신 동의를 5분 넘게 확인하지 못하면 녹음을 멈춘다(조회는 녹음 중에는 화면 뒤에서도 돈다)
                    if (it !is Gone && s.trip?.code == t.code) s = s.consentUnseen(System.currentTimeMillis() - consentSeenAt)
                    // 서버에 닿지 않아도(끊김) 차 안 대조는 잇는다: 마지막으로 동의를 확인한 지 5분 안이고 그때 모두 동의였을 때만.
                    // 서버가 거절한 것(ApiError)은 동의·권한이 달라졌을 수 있어 잇지 않는다
                    if (it !is ApiError && it !is Gone && System.currentTimeMillis() - consentSeenAt < CONSENT_FRESH_MS && s.trip?.code == t.code) { speakers(t); s.trip?.let(::places) } // 장소도 끊긴 동안 쌓았다 나중에 보낸다
                }
        }
    }

    private fun placesOf(code: String) = placeLog?.takeIf { it.trip == code } ?: PlaceLog(filesDir, code, Live.seal(this)).also { placeLog = it }

    /**
     * 장소 기록(T149): 여행 조회가 성공한 뒤(끊겼으면 마지막 동의 확인 5분 안에서만), 모두 동의한 동안에만 내비의 출발·목적지를 남기고 밀린 것을 보낸다
     * (곧 도착은 approaching(), 도착·경유는 arrive()).
     * 콘텐츠 기록 타임라인·지도의 장소 이름과 폰의 '…로 이동 중'이 이것을 읽는다. 위치는 기록 중에 물어 둔 마지막 위치(1분 안)만 붙인다.
     */
    private fun places(t: Trip) {
        if (!s.consented || s.offPending) return
        car.destinationNamed { dest ->
            if (s.trip?.code != t.code || !s.consented || s.offPending) return@destinationNamed
            val now = System.currentTimeMillis()
            val gear = carStatus.gear
            placesOf(t.code).see(gear != null && gear != "P", dest, Live.fix?.takeIf { now - it.at in 0..60_000 }, t.generation, now)
            sendPlaces(t)
        }
    }

    /** 밀린 장소를 하나씩 보낸다. 끊기거나 서버 오류면 남겨 두었다 다음 조회에 다시(관측 시각 at을 붙여 보내므로 제자리에 들어감). */
    private fun sendPlaces(t: Trip) {
        val log = placesOf(t.code)
        val up = tokens.minByOrNull { it.key }?.value ?: return
        if (placing || !s.consented || s.offPending) return
        val next = log.next(t.generation) ?: return
        placing = true
        val url = server
        bg({ Server(url).place(t.code, up, next) }) { r ->
            placing = false
            val e = r.exceptionOrNull()
            if (e != null && !(e is ApiError && e.status == 400)) { Log.w(TAG, "장소 올리기 못 함 ${if (e is ApiError) e.message else "연결"}"); return@bg }
            log.done(next) // 400: 서버가 받지 않는 값(여행 전 시각 등)은 다시 보내지 않는다
            if (s.trip?.code == t.code) sendPlaces(t)
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
     * 말한 사람(T37, ADR-0023): 서버가 받았지만 아직 대조하지 않은 발화(한 차례 20건)를 차 안에서 대조하고, 찾은 사람과
     * 사람이 고친 것 가운데 서버에 남기지 못한 것을 보낸다. 올릴 새 발화가 있든 없든 조회마다 본다(밀린 것을 이어 하게).
     * 소리는 차 밖으로 나가지 않는다. 원음을 풀어 읽으므로 클립과 같은 따로 둔 실행기에서 돌고, 발화마다 '모두 동의, 끄기 대기 없음'을 다시 본다.
     */
    private fun speakers(t: Trip) {
        val box = Live.box?.takeIf { it.trip == t.code } ?: return
        val up = tokens.minByOrNull { it.key }?.value ?: return
        if (matching || !clipsAllowed) return
        val sp = speakersOf(t.code)
        val vp = printsOf(t.code)
        // 등록값이 있을 만할 때만 대조한다(이 차에서 등록했거나 프로필 참가자가 있음)
        val todo = if (voiced.isNotEmpty() || t.people.any { it.profile }) box.ackedAfter(sp.through).take(MATCH_MAX) else emptyList()
        if (todo.isEmpty() && sp.unsent().isEmpty() && sp.unsentMatches().isEmpty()) return
        matching = true
        val url = server; val dev = device
        if (!clipIo.isShutdown) clipIo.execute {
            val api = Server(url)
            // 대조는 차 안에서 끝나므로 먼저 하고, 보내기(고친 것, 찾은 화자)가 실패해도 대조를 막지 않는다(끊긴 동안에도 사본으로 대조)
            val failed = speakerRound(
                match = { if (todo.isNotEmpty()) { refreshPrints(api, t, up, vp); match(t, todo, sp, vp) } },
                fixes = { for ((seq, f) in sp.unsent()) { api.fixSpeaker(t.code, up, dev, seq, f.who); sp.set(seq, f.copy(sent = true)) } },
                // 찾은 사람을 그 발화와 함께 다시 올린다. 서버는 화자가 빈 줄에만 채운다(사람이 고친 줄은 그대로)
                send = { sendSpeakers(box, sp, { clipsAllowed }) { items -> api.utterances(t.code, up, dev, items) } },
            )
            main.post {
                matching = false; heardTick++
                failed?.let { Log.i(TAG, "말한 사람 대조·남기기 미룸 ${if (it is ApiError) it.status else "연결"}") }
            }
        }
    }

    /**
     * 대조 값 사본을 서버에서 받는다(통신 스레드). 기록을 시작한 뒤 첫 대조 전에 받아 3시간 30분 쓰고(PRINTS_KEEP_MS), 탑승자·동의가 바뀌거나
     * 이 차에서 등록하면 다시 받는다. 끊겼으면 보관 시간 안의 사본으로 대조한다.
     * 서버가 거절하면(동의 대기 403, 옛 서버 404) 던져서 이번 차례의 대조를 미룬다. 소리를 서버로 보내는 옛 대조로 돌아가지 않는다.
     */
    private fun refreshPrints(api: Server, t: Trip, token: String, vp: VoicePrints) {
        if (vp.refresh(System.currentTimeMillis(), t.generation) { api.voicePrints(t.code, token) })
            Log.i("GachitaCapture", "대조 값 ${vp.size}명 받음") // 값·이름은 남기지 않는다
    }

    /** 명시한 디버그 시험 기간이 지난 여행만 정리한다. 운영 기본값에서는 호출하지 않는다. */
    private fun expire() {
        sweep(filesDir, Live.seal(this), System.currentTimeMillis(), retentionMs).forEach { code ->
            Live.forget(code)
            if (s.trip?.code == code) { newTrip(); error = "시험용 보관 기간이 지나 이 차에 남은 기록을 지웠어요" }
        }
    }

    /**
     * 사람이 확정한 장면(moments)의 구간을 이 차의 원음에서 16 kHz 모노 WAV로 잘라 올린다(T63 → T76 POST /recordings). 모두 동의한 동안만.
     * 구간이 끝나고 3초가 지난 장면만 본다(아직 녹음 중인 구간을 자르지 않게). 원음이 이 차에 없거나 서버가 버리라고 하면(400·404·409·413) 다시 하지 않는다.
     * ponytail: 차 앱이 켜져 있을 때만 올린다. 폰에서 장면을 고른 뒤 차가 꺼져 있으면 동의가 유효한 채 다음에 앱을 켤 때.
     */
    /**
     * 여행을 마치면(주차·종료, 녹음 안 함, 모두 동의, 끄기 대기 없음) 이 차의 원음 전체를 올린다(T132, ADR-0024, FullAudio.kt).
     * 올리는 사람은 발화를 올린 그 참가자(서버는 그 기기만 받는다). 조각마다 다시 본다: 다시 출발하거나 동의를 끄면 멈추고 다음 조회에서 이어 간다.
     */
    private fun fullAudio(t: Trip) {
        if (t.status !in setOf("parked", "ended") || !s.consented || s.offPending || CaptureService.running) return
        val up = tokens.minByOrNull { it.key }?.value ?: return
        val code = t.code; val gen = t.generation
        FullAudio.start(filesDir, Live.seal(this), server, code, gen, up) {
            clipsAllowed && !CaptureService.running && s.trip?.let { it.code == code && it.generation == gen && it.status in setOf("parked", "ended") } == true
        }
    }

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

    /** 그 여행의 원음을 모두 지운다. 원음 쓰기와 같은 잠금 안에서(쓰던 파일까지). 지운 파일 수. */
    private fun dropRawAll(code: String): Int = synchronized(RAW_LOCK) { RawFile.of(filesDir, code).count { it.file.delete() } }

    /**
     * 말한 사람(T37, ADR-0023): 발화마다 이 차의 원음에서 그 구간(첫 결과 쪽 0.5초를 빼고 10초까지)을 잘라 차 안에서 벡터로 바꾸고,
     * 받아 둔 탑승자의 대조 값과 견준다(서버의 /voice-match와 같은 규칙·같은 기준). 좌석 구역이 있으면 그 줄의 사람만 후보다.
     * 소리와 발화의 벡터는 남기지도 보내지도 않는다. 원음이 없으면 건너뛴다.
     */
    private fun match(t: Trip, items: List<Utterance>, sp: Speakers, vp: VoicePrints) {
        val files = RawFile.of(filesDir, t.code)
        val seated = t.people.filter { it.consent } // 동의하지 않은 사람의 이름은 붙이지 않는다
        for (u in items) {
            val to = u.endedAt - 500 // 최종 결과는 말 끝 0.6초 뒤에 온다(11/13): 끝의 무음을 덜어 목소리만
            val from = maxOf(u.startedAt + LEAD_MS / 2, to - 9_900) // 서버 대조와 같은 구간(0.5~10초)
            if (!clipsAllowed) return // 그사이 동의를 껐으면(철회) 원음을 더 읽지 않는다
            val pcm = if (to - from < 600) null else clipFile(files, from..to)?.let { runCatching { it.cut(Live.seal(this), from, to) }.getOrNull() }
            val v = pcm?.takeIf { it.size >= RATE }?.let { embed(pcmSamples(it)) }
            if (v == null) { sp.done(u.seq); continue } // 원음이 없거나 짧음: 다시 하지 않음
            val row = u.seatZone?.let { z -> seated.filter { it.seat.startsWith("ROW_${z + 1}_") } }
            val r = vp.identify(v, seated.map(Person::id), row?.map(Person::id)) // 여백 규칙(Voice.kt)
            sp.set(u.seq, r.copy(sent = r.who == null)); sp.done(u.seq) // 찾았으면 서버에 남길 때까지 sent = false
            Log.i("GachitaCapture", "말한 사람 ${u.seq} 구역 ${u.seatZone ?: "모름"} ${if (r.who != null) "찾음" else "모름"} ${r.confidence}") // 이름·글자는 남기지 않는다
        }
    }

    /**
     * 대조 값 사본을 바로 버린다(ADR-0023): 이 차에서 동의를 철회할 때(끊겨서 서버에 전하지 못해도), 여행을 떠나거나 여행이 지워질 때.
     * 진행 중인 조회의 늦은 응답도 저장되지 않는다. 철회 대기 중에는 대조가 돌지 않으니(clipsAllowed) 다시 받지도 않는다.
     */
    private fun dropPrints() { prints?.drop(); prints = null }

    private fun printsOf(code: String): VoicePrints = prints?.takeIf { it.trip == code } ?: VoicePrints(filesDir, code, Live.seal(this)).also { prints = it }
    private fun speakersOf(code: String): Speakers = speakers?.takeIf { it.trip == code } ?: Speakers(filesDir, code, Live.seal(this)).also { speakers = it; heardTick++ }

    /** 서버에서 삭제된 여행: 기록을 멈추고 이 차의 사본(보관함·할 일)을 지운 뒤 처음 화면으로. */
    private fun forget(code: String) {
        val current = s.trip?.code == code
        if (current) newTrip() // 기록을 멈추고 처음 화면으로
        if (placeLog?.trip == code) placeLog = null
        dropTrip(filesDir, code); Live.forget(code) // 새 여행을 만든 뒤 늦게 온 앞 여행의 404여도 그 사본은 지운다
        if (current) error = "서버에 없는 여행이라 이 차에 남은 기록도 지웠어요"
    }

    /**
     * 도착 전 브리핑(C19·finalNear, F4): 주행 중 조회마다 내비의 다음 도착지(첫 경유지, 없으면 목적지) 이름과 남은 시간을 읽어 둔다.
     * 5분 이하면 함께 타는 중 가운데 칸에 그 장소의 서버 할 일을 카드로 보이고, 폰(P19)도 보도록 서버에 '곧 도착'을 남긴다(POST /places,
     * 녹음에 동의한 참가자 토큰, 같은 분 안에는 한 번). 휴게소를 찾는 중이면 그 물음을 끊지 않게 묻지 않는다.
     */
    private fun approaching() {
        val code = s.trip?.code
        if (code == null || !carStatus.restricted || !s.agreed || offer?.stage == Offer.Stage.FINDING || arrivalLoading) { if (!carStatus.restricted) near = null; return }
        car.nextPlaceEta { name, sec, final ->
            if (s.trip?.code != code || !carStatus.restricted) return@nextPlaceEta
            nextPlaceName = name?.takeIf { it.isNotBlank() }
            val a = approach(code, name, sec, final, approachLimit)
            if (debug && "$name|$sec" != etaSeen) { etaSeen = "$name|$sec"; Log.i(TAG, "다음 장소 $name 남은 ${sec}초 · 카드 ${if (a != null) "보임" else "없음"}") } // 시연·E2E 확인용
            near = a
            // 폰(P19)도 보도록 '곧 도착'을 장소 기록에 남긴다(T149 PlaceLog: 같은 장소·같은 분에 한 번, 끊기면 두었다 나중에, 모두 동의한 동안만)
            val t = s.trip?.takeIf { it.code == code } ?: return@nextPlaceEta
            if (a != null && s.consented && !s.offPending && placesOf(code).approach(a.place, a.minutes, a.seconds, t.generation, System.currentTimeMillis())) sendPlaces(t)
        }
    }

    /** 기록 중이면 내비에 지금 위치를 물어 둔다. 발화에 붙인다(FIX_MS). 휴게소를 찾는 중이면 그 물음을 끊지 않게 묻지 않는다. */
    private fun locate() {
        if (!s.recording || offer?.stage == Offer.Stage.FINDING || arrivalLoading) return
        car.here { la, ln, _ -> if (la != null && ln != null) Live.fix = Fix(la, ln, System.currentTimeMillis()) }
    }

    /**
     * 차가 기어 D로 나가면 여행을 주행으로 바꾼다(아직 대기·주차 상태일 때만, 조회마다 다시 시도). 서버는 모두 동의했을 때만 기록 표시를 켜고,
     * 차는 그 값을 받아 autoRecord로 녹음을 시작한다. 동의가 없으면 서버가 켜지 않으므로 녹음도 시작하지 않는다.
     */
    private fun depart() {
        val t = s.trip ?: return
        // 이미 주행인데 서버 기록이 꺼져 있고 차가 아는 동의가 모두 켜졌으면(주행 전환 뒤에 동의가 모임) 한 번 더 알려 서버가 기록 표시를 다시 계산하게 한다
        val again = t.status == "driving" && !t.recording && s.agreed && !s.started
        if (carStatus.gear != "D" || (t.status !in setOf("boarding", "parked") && !again) || departing) return
        val token = tokens.minByOrNull { it.key }?.value ?: return
        departing = true
        val url = server
        bg({ Server(url).departed(t.code, token) }) { r ->
            departing = false
            r.onSuccess { got -> if (s.trip?.code == t.code && server == url) s = s.withTrip(keep(got)) }
                .onFailure { Log.i(TAG, "주행 알림 미룸 ${if (it is ApiError) it.status else "연결"}") }
        }
    }

    /**
     * 자동 시작(C03·C13): 서버가 주행·모두 동의로 기록을 켰으면 시작 단추 없이 녹음한다. 시작할 때마다 서버에서 동의를 다시 읽는다.
     * 실패한 여행 판에서는 다시 시도하지 않는다(서버 여행이 바뀌면 다시). 동의 확인이 끊겨 멈춘 뒤(T139)에도 다시 닿아 확인되면 이어서 녹음한다.
     */
    private fun autoRecord() {
        val t = s.trip ?: return
        if (isDestroyed || !s.autoStart || cancelRecordingStart != null) return
        val key = "${t.code}:${t.generation}:${t.version}"
        if (key == autoFailed) return
        Log.i(TAG, "자동 녹음 시작 요청")
        startRecording(auto = true) { ok, _ -> autoFailed = if (ok) "" else key }
    }

    /**
     * 터치·음성·자동 모두 같은 최신 동의 검사로 시작하며, 늦은 응답은 수음을 켜지 않는다. 터치와 음성은 주차 중에만,
     * 자동(auto)은 서버가 주행·모두 동의로 기록을 켰을 때만(Session.blockAutoStart) 시작한다.
     */
    private fun startRecording(auto: Boolean = false, done: (Boolean, String) -> Unit = { _, _ -> }) {
        val trip = s.trip
        fun blocked(x: Session) = if (auto) x.blockAutoStart() else x.blockStart()
        if (trip == null || !auto && carStatus.restricted || blocked(s) != null) {
            done(false, "Recording requires parking, a connection and every passenger's consent.")
            return
        }
        val url = server
        val attempt = RecordingStartAttempt(trip.code, trip.generation, android.os.SystemClock.elapsedRealtime())
        val timeout = Runnable { cancelRecordingStart?.invoke() }
        fun finish(ok: Boolean, message: String) {
            if (!attempt.finish()) return
            main.removeCallbacks(timeout)
            cancelRecordingStart = null
            s = s.copy(busy = false, note = if (ok || auto) "" else "녹음을 시작하지 못했어요. 주차·동의·연결 상태를 확인해 주세요")
            done(ok, message)
        }
        cancelRecordingStart = { finish(false, "Recording did not start. The request timed out or was cancelled.") }
        s = s.copy(busy = true, note = if (auto) s.note else "동의를 확인하고 있어요")
        main.postDelayed(timeout, RECORDING_START_TIMEOUT_MS)
        fun current(): Boolean = !isDestroyed && server == url && attempt.accepts(s.trip, android.os.SystemClock.elapsedRealtime())
        car.readGear { gear ->
            if (!current()) { finish(false, "The trip changed before recording started."); return@readGear }
            s = s.withGear(gear)
            if (!auto && carStatus.restricted || blocked(s.copy(busy = false)) != null) {
                finish(false, "Recording requires parking and every passenger's consent.")
                return@readGear
            }
            recordingIo.execute {
                val result = runCatching { retryTransient { Server(url).trip(trip.code) } ?: error("Trip is no longer available") } // 조회라 다시 물어도 같다(T122)
                main.post {
                    if (!current()) { finish(false, "The trip changed or the request timed out."); return@post }
                    result.onSuccess { got ->
                        val ready = s.copy(busy = false).withTrip(got.trip)
                        if (!attempt.accepts(got.trip, android.os.SystemClock.elapsedRealtime()) || !auto && carStatus.restricted || blocked(ready) != null) {
                            finish(false, "Consent or parking changed. Recording did not start.")
                        } else {
                            if (Live.mic == Mic.FAILED) { Live.set(Mic.OFF); askedMic = false }
                            s = ready.withTrip(keep(got)).startRecording(auto)
                            finish(s.recording, "Recording is enabled. Audio capture begins when the microphone is available after this voice command.")
                        }
                    }.onFailure { finish(false, "The server could not confirm passenger consent. Recording did not start.") }
                }
            }
        }
    }

    private fun recordingAction() {
        cancelRecordingStart?.invoke()
        when {
            s.recording -> {
                if (muted && Live.mic == Mic.FAILED) { Live.set(Mic.OFF); askedMic = false }
                s = s.copy(note = ""); mute(!muted); syncCapture()
            }
            s.agreed -> startRecording()
            // 동의 전에는 큰 단추가 꺼진 안내다(시안 C17 막대에는 일시정지·녹화 재개·녹화 종료만). 동의는 각자 휴대폰에서 한다.
        }
    }

    private fun newTrip() {
        destination = Destination.RIDE; closeBoarding(); clearTranscript()
        prefs.edit().remove("trip").remove("tokens").commit()
        sweep(filesDir, Live.seal(this), System.currentTimeMillis(), retentionMs).forEach(Live::forget)
        tokens = emptyMap()
        s = Session(gear = s.gear)
        offer = null; todoState = todoState.bind(null); arrivalRequest++; arrivalLoading = false; arrivalNote = ""; brief = null; speakers = null; dropPrints(); voiced = emptySet()
    }

    // ---- 부탁을 경유지로(T9). 서버의 부탁 상태: held → proposed → accepted → reflected, 못 넣으면 held(openapi.yaml) ----
    // 제안은 한 번에 하나(offer)이고 단계는 FINDING → ASKING → ADDING → ADDED·FAILED. 새 부탁은 열린 제안에 묶인다.

    /** 받아 적은 말 한 건(메인 스레드). Gleo 호출어(T41), 열린 제안에 대한 답, 쉬어 가자는 부탁, 모호한 답 순서로 봅니다. 장소별 할 일은 서버 전사에서 읽습니다. */
    private fun heard(u: Utterance) {
        val t = s.trip?.takeIf { it.code == u.trip } ?: return
        if (isWake(u.text)) { if (Live.mic == Mic.ON) handoff.give(wake = true); return }
        val o = offer?.takeIf { it.stage == Offer.Stage.ASKING }
        val a = answerOf(u.text)
        if (o != null && a != Answer.UNCLEAR) { // "그래, 쉬었다 가자"도 수락이다
            if (a == Answer.NO) later(o) else if (canAccept(u)) accept(o) else Log.i(TAG, "뒷줄의 수락은 받지 않음")
            return
        }
        if (isRestRequest(u.text, nextPlaceName ?: near?.place)) return hold(t, u) // '하나로마트 가면 화장실…'은 도착 할 일(F4), 휴게소 제안 아님
        // 장소별 할 일은 서버 전사에서 읽습니다. 기존 경유지 재질문 분기만 건너뛰고 로컬 목록에는 더하지 않습니다(T113).
        if (todoOf(u.text) != null) return
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

    /**
     * 지금 경로에서 들를 휴게소를 고르고 그곳까지의 거리·시간을 내비에 묻고 제안한다. 화면은 넘어가지 않는다. 답이 없으면 30초 뒤 보관.
     * 후보는 서버 추천(T97: 내비의 지금 위치·진행 방향·목적지·남은 길로 고름). 서버가 꺼졌거나 닿지 않거나 위치를 모르면 고정 목록(nextStop).
     * 서버가 빈 목록으로 답하면 앞에 들를 곳이 없는 것이다(고정 목록으로 가면 다른 길의 휴게소를 제안하게 됨).
     */
    private fun propose(o: Offer, u: Utterance) {
        car.here { lat, lng, heading ->
            car.destination { to, remain ->
                val url = server
                val known = lat != null && lng != null && !(lat == 0.0 && lng == 0.0)
                // 2초 안에 답이 없으면 통신이 끝나지 않았어도 고정 목록으로 간다. 늦게 온 답은 within이 버린다.
                within(stopsIo, 2_000, { if (known) Server(url).restStops(lat!!, lng!!, heading, to, remain) else throw IllegalStateException("위치 모름") }) { r -> main.post post@{
                    if (isDestroyed) return@post
                    r.exceptionOrNull()?.let { Log.w(TAG, "휴게소 추천을 받지 못함 · 고정 목록으로", it) }
                    val stops = stopsFrom(r, lat, lng)
                    Log.i(TAG, "휴게소 후보 ${stops.size}곳 · ${if (r.isSuccess) "추천 서버" else "고정 목록"} · 목적지 ${to != null} · 남은 길 ${remain != null}")
                    if (stops.isEmpty()) { Log.i(TAG, "남은 휴게소 없음 · 부탁은 보관"); if (offer?.id == o.id) offer = null; return@post }
                    ask(o, u, stops, lat, lng, remain)
                } }
            }
        }
    }

    /**
     * 후보를 차례로 내비에 물어(requestTrip, 화면 그대로 0.1~0.2초) 길 위 거리가 지금 길에서 들르는 곳으로 보이는 첫 곳을 제안한다(onRoad).
     * 모두 아니면 첫 후보를 제안한다. 위치를 모르면 거르지 않는다.
     */
    private fun ask(o: Offer, u: Utterance, stops: List<Place>, lat: Double?, lng: Double?, remain: Int?, i: Int = 0, first: Triple<Place, Int?, Int?>? = null) {
        val stop = stops[i]
        car.distanceTo(stop) { m, sec ->
            val cur = offer?.takeIf { it.id == o.id } ?: return@distanceTo
            val straight = if (lat != null && lng != null) meters(lat, lng, stop.lat, stop.lng) else null
            val here = Triple(stop, m, sec)
            val fits = straight == null || onRoad(straight, m, remain)
            if (!fits) Log.i(TAG, "${stop.name}: 길 위 ${m}m, 직선 ${straight?.toInt()}m · 지금 길에서 들르는 곳이 아님")
            if (!fits && i + 1 < stops.size) return@distanceTo ask(o, u, stops, lat, lng, remain, i + 1, first ?: here)
            val (pick, pm, ps) = if (fits) here else first ?: here
            offer = cur.copy(stop = pick, meters = pm, seconds = ps, stage = Offer.Stage.ASKING)
            Log.i(TAG, "제안 ${pick.name} 부탁 ${cur.requests.size}건 · 최종 결과에서 ${System.currentTimeMillis() - u.endedAt}ms · 위치 ${lat != null}")
            car.speak("${pick.spoken}에 들를까요?")
            mark(cur.trip, cur.requests, "proposed")
            main.postDelayed({ offer?.takeIf { it.id == o.id && it.stage == Offer.Stage.ASKING }?.let { later(it, timedOut = true) } }, OFFER_MS)
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

    // ---- 서버 할 일과 실제 도착 브리핑(T113/T103) ----

    private fun todoScope(): TodoScope? = if (!s.agreed) null else contentScope()?.let { TodoScope(server, it.code, it.generation, it.token) }
    private fun syncTodoScope() {
        val scope = todoScope()
        if (todoState.scope != scope) {
            todoState = todoState.bind(scope); brief = null; arrivalRequest++; arrivalLoading = false; arrivalNote = ""
        }
    }
    private fun vehicleParked() = carStatus.gear == "P" && s.gear == "P" && !carStatus.restricted
    private fun reconcileBrief() {
        brief = brief?.let { b -> b.copy(arrivalItems = b.arrivalItems?.mapNotNull { old -> todoList.find { it.id == old.id && it.pending } }) }
    }

    private fun loadTodos(force: Boolean = false, done: ((Result<SharedTodos>) -> Unit)? = null) {
        syncTodoScope()
        val scope = todoState.scope ?: run { done?.invoke(Result.failure(IllegalStateException("참가자 동의가 필요해요"))); return }
        if (todoState.loading || !force && System.currentTimeMillis() - todosRequestedAt < 10_000) {
            done?.invoke(Result.failure(IllegalStateException("목록을 갱신하고 있어요. 잠시 뒤 다시 시도해 주세요"))); return
        }
        val (next, attempt) = todoState.begin(); todoState = next; todosRequestedAt = System.currentTimeMillis()
        bg({ Server(scope.server).todos(scope.trip, scope.token) }) { result ->
            if (isDestroyed || todoScope() != scope || !todoState.accepts(attempt)) {
                done?.invoke(Result.failure(IllegalStateException("여행이나 동의 상태가 바뀌었어요"))); return@bg
            }
            result.onSuccess { data ->
                todoState = todoState.received(attempt, data, System.currentTimeMillis())
                if (data.generation != scope.generation) { brief = null; refresh(); done?.invoke(Result.failure(IllegalStateException("동의 세대가 바뀌었어요"))); return@onSuccess }
                reconcileBrief(); done?.invoke(Result.success(data))
            }.onFailure { e ->
                todoState = todoState.failed(attempt, "목록을 갱신하지 못했어요 · ${reason(e)}", e is ApiError && e.status in setOf(401, 403, 404))
                if (e is ApiError && e.status in setOf(401, 403, 404)) { brief = null; refresh() }
                done?.invoke(Result.failure(e))
            }
        }
    }

    /** 이름·위치를 SDK로 읽고 실제 P 상태를 재확인합니다. 좌표가 없거나 서버가 거절하면 도착했다고 말하지 않습니다. */
    private fun arrive() {
        syncTodoScope()
        val scope = todoScope() ?: return
        if (!vehicleParked() || !appVisible || arrivalLoading) return
        val request = ++arrivalRequest; val navigation = carStatus.naviEvent
        arrivalLoading = true; arrivalNote = ""
        fun current() = !isDestroyed && appVisible && arrivalRequest == request && todoScope() == scope && vehicleParked() && carStatus.naviEvent == navigation
        // 도착을 확인하지 못하면 카드를 띄우지 않고 까닭만 함께 타는 중의 알림 자리에 남긴다(RideOverview, 주차한 동안만)
        fun failed(note: String) {
            if (!current()) return
            arrivalLoading = false; arrivalNote = note; loadTodos(force = true)
        }
        car.nextArrivalPlace place@{ place, final ->
            if (!current()) return@place
            if (place == null) { failed("내비의 다음 장소 좌표를 확인하지 못했어요. 도착 안내를 보류했어요"); return@place }
            car.here position@{ lat, lng, _ ->
                if (!current()) return@position
                if (!vehiclePoint(lat, lng)) { failed("현재 위치를 확인하지 못했어요. 도착 안내를 보류했어요"); return@position }
                val observed = VehicleArrival(place, lat!!, lng!!, System.currentTimeMillis())
                bg({
                    check(arrivalRequest == request && System.currentTimeMillis() - observed.observedAt in 0L..60_000L) { "차량 관측이 바뀌었어요" }
                    Server(scope.server).parkedForArrival(scope.trip, scope.token)
                }) parked@{ result ->
                    if (!current()) return@parked
                    val got = result.getOrElse { failed("주차 상태를 서버에 알리지 못했어요 · ${reason(it)}"); return@parked }
                    s = s.withTrip(keep(got))
                    if (!current()) return@parked
                    bg({
                        check(arrivalRequest == request) { "차량 상태가 바뀌었어요" }
                        Server(scope.server).arrivalBriefing(scope.trip, scope.token, scope.generation, observed)
                    }) checked@{ checked ->
                        if (!current()) return@checked
                        arrivalLoading = false
                        val answer = checked.getOrElse { failed("도착 확인을 마치지 못했어요 · ${reason(it)}"); return@checked }
                        // 장소 기록(T149): 서버가 이 장소에 닿았다고 본 도착은 최종 목적지면 도착, 아니면 경유로 남긴다(폰 P20·기록이 같은 곳을 봄, 모두 동의한 동안만)
                        if (answer.eligible && s.consented) s.trip?.takeIf { it.code == scope.trip }?.let { t -> if (placesOf(t.code).arrived(place, final, t.generation, observed.observedAt)) sendPlaces(t) }
                        if (!canReadArrival(answer, observed, scope, todoScope(), vehicleParked(), System.currentTimeMillis())) {
                            failed(when (answer.reason) {
                                "outside_place" -> "아직 이 장소에 도착하지 않았어요"
                                "stale_position" -> "위치가 오래됐어요. 다시 확인해 주세요"
                                "not_parked" -> "주차 상태를 다시 확인해 주세요"
                                else -> "도착 근거가 바뀌었어요. 다시 확인해 주세요"
                            }); return@checked
                        }
                        if (answer.items.isNotEmpty()) {
                            brief = Brief(place.name, answer.items, final)
                            car.speak(sharedBriefingLine(place.name, answer.items))
                        }
                        loadTodos(force = true)
                    }
                }
            }
        }
    }

    /**
     * Gleo 녹음 제어(assets/schema.json, component activity). 동의와 녹음 실행은 별개다.
     * Callback message는 영어, 실제 상태는 data로 반환한다. 말은 Gleo가 하므로 우리 TTS는 쓰지 않는다.
     * Gleo는 함수 이름이나 '<패키지>.<함수 이름>'을 action으로 보낸다(11/1 프로브). 응답의 functionName은 schema의 함수 이름 그대로.
     */
    private fun gleo(i: Intent?) {
        val fn = i?.action?.substringAfterLast('.') ?: return
        when (fn) {
            // 이전 판 호출 호환. 장소별 할 일 목록(옛 카드)은 지웠고 도착 안내는 주차 뒤 도착 브리핑(C20)이 맡는다. 새 schema의 세 진입점은 녹음 제어다.
            GLEO_ARRIVAL -> reply(fn, false, "Arrival tasks are no longer available by voice. The arrival briefing appears on the car screen after parking.")
            GLEO_START -> {
                Log.i(TAG, "Gleo 요청 $fn")
                when {
                    s.recording -> reply(fn, !muted, if (muted) "Recording is paused. Ask to resume recording." else "Recording is already enabled.")
                    checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED ->
                        reply(fn, false, "Microphone permission is required. Open Gachita and grant microphone permission while parked.")
                    else -> {
                        destination = Destination.RIDE; closeBoarding()
                        startRecording { ok, message -> recordingReply(fn, ok, message) }
                    }
                }
            }
            GLEO_PAUSE -> {
                Log.i(TAG, "Gleo 요청 $fn")
                cancelRecordingStart?.invoke()
                if (s.recording) { mute(true); syncCapture() }
                recordingReply(fn, true, if (s.recording) "Recording is paused. Consent and saved records are unchanged." else "Recording is already stopped.")
            }
            GLEO_RESUME -> {
                Log.i(TAG, "Gleo 요청 $fn")
                val on = s.recording
                when {
                    !on -> recordingReply(fn, false, "Recording has not started. Ask to start recording while parked with passenger consent.")
                    checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED ->
                        recordingReply(fn, false, "Microphone permission is required before recording can resume.")
                    else -> {
                        destination = Destination.RIDE; closeBoarding()
                        mute(false); syncCapture()
                        recordingReply(fn, true, "Recording is enabled again. Audio capture resumes when the microphone is available after this voice command.")
                    }
                }
            }
        }
    }

    private fun recordingReply(fn: String, ok: Boolean, message: String) {
        val data = JSONArray().put(JSONObject().put("recordingEnabled", s.recording && !muted)
            .put("paused", s.recording && muted).put("microphoneState", Live.mic.name)
            .put("passengerConsent", s.agreed)).toString()
        reply(fn, ok, message, data)
    }

    // ---- 차량 참석 QR(T106). 폰 카메라가 URL을 읽어 참여한다 ----

    private fun revokeInvite() {
        val request = boardingCall
        boardingCall = null
        boardingRequest++
        val invite = request?.call?.cancel()
        if (request != null && invite != null && !boardingIo.isShutdown) boardingIo.execute {
            runCatching { Server(request.attempt.server).revokeBoardingInvite(request.attempt.trip, request.token, invite.id) }
                .onFailure { Log.i(TAG, "참석 QR 폐기 확인 못함 · 서버 만료까지 유지") }
        }
    }

    private fun openBoarding() {
        if (carStatus.restricted) return
        revokeInvite()
        boarding = BoardingState(BoardingPage.PEOPLE)
    }

    /** '함께 타는 중'(탭·C33 '우리 가족 N명'): 주행 중이면 C17, 주차 중이면 시안대로 C16 groups(가족 흐름). */
    private fun goRide() {
        if (!carStatus.restricted && f4Mock !in MOCK_DRIVING) { familyJump = FamilyJump.GROUPS; familyOpen = true } else destination = Destination.RIDE
    }

    private fun closeBoarding() {
        revokeInvite()
        boarding = BoardingState()
    }

    private fun boardingAction(action: BoardingAction) {
        when (action) {
            BoardingAction.Close -> closeBoarding()
            BoardingAction.Back -> openBoarding()
            BoardingAction.Invite -> invitePassengers()
            BoardingAction.ExpireInvite -> {
                revokeInvite()
                boarding = boarding.copy(invite = null, issuing = false, note = "참석 QR 시간이 끝났어요. 새 QR을 만들어 주세요.")
            }
            // C16B 좌석을 누르면 C16C '누가 앉나요?'(그 좌석), 사람을 고르면 그 사람을 그 자리로 옮긴다(빈자리 또는 이미 그 자리인 사람).
            is BoardingAction.PickSeat -> if (!carStatus.restricted && !s.busy) { revokeInvite(); boarding = BoardingState(BoardingPage.SEAT, seat = action.seat) }
            is BoardingAction.Move -> if (!carStatus.restricted && !s.busy) {
                val trip = s.trip
                if (trip != null && !selectableSeat(trip, carStatus.seats, boarding.seat, action.person.id)) boarding = boarding.copy(note = "빈자리로만 옮길 수 있어요")
                else { boarding = boarding.copy(personId = action.person.id, note = ""); connectPassenger() }
            }
        }
    }

    private fun invitePassengers() {
        val trip = s.trip ?: return
        if (carStatus.restricted || s.gear != "P" || s.busy || !s.online || boarding.issuing || freeSeats(trip, carStatus.seats).isEmpty()) return
        val driver = trip.people.firstOrNull { it.seat == Seat.ROW_1_LEFT.name && it.id in tokens } ?: return
        revokeInvite()
        val request = BoardingRequest(BoardingInviteAttempt(boardingRequest, trip.code, server, driver.id), tokens.getValue(driver.id))
        boardingCall = request
        boarding = BoardingState(BoardingPage.QR, issuing = true, joinedBefore = trip.people.map { it.id }.toSet())
        main.removeCallbacks(tick); main.post(tick)
        boardingIo.execute {
            val api = Server(request.attempt.server)
            val result = runCatching { api.boardingInvite(trip.code, request.token) }
            val issued = result.getOrNull()
            if (issued != null && !request.call.issued(issued)) {
                runCatching { api.revokeBoardingInvite(trip.code, request.token, issued.id) }
                return@execute
            }
            main.post {
                val current = boardingCall === request && boarding.page == BoardingPage.QR && !isDestroyed &&
                    request.attempt.accepts(boardingRequest, s.trip, server, tokens.keys, !carStatus.restricted && s.gear == "P", appVisible)
                if (!current) {
                    if (boardingCall === request) { revokeInvite(); boarding = BoardingState(BoardingPage.PEOPLE) }
                    return@post
                }
                result.onSuccess { boarding = boarding.copy(invite = it, issuing = false, note = "") }
                    .onFailure { boarding = boarding.copy(invite = null, issuing = false, note = boardingFailure(it)) }
            }
        }
    }

    /** 자리 변경(동승자 설정 → 자리 변경)은 현재 빈자리와 주차 상태를 다시 확인한다. 새 동승자는 휴대폰 QR로만 들어온다. 늦은 결과는 다른 화면의 입력을 덮지 않는다. */
    private fun connectPassenger() {
        val trip = s.trip ?: return
        val form = boarding
        val seat = form.seat ?: return
        val id = form.personId ?: return
        if (carStatus.restricted || s.gear != "P" || s.busy || !s.online || !selectableSeat(trip, carStatus.seats, seat, id)) return
        val url = server
        val request = ++boardingRequest
        s = s.copy(busy = true)
        boarding = form.copy(note = "")
        bg({
            val api = Server(url)
            api.seat(trip.code, id, seat)
            runCatching { api.trip(trip.code)!! }.getOrNull()
        }) { result ->
            if (s.trip?.code != trip.code || server != url) return@bg
            s = s.copy(busy = false)
            result.onSuccess { got ->
                if (got != null) s = s.withTrip(keep(got))
                if (request == boardingRequest && !carStatus.restricted) boarding = BoardingState(BoardingPage.PEOPLE)
                refresh()
            }.onFailure { error ->
                if (request == boardingRequest) {
                    boarding = form.copy(seat = null, note = boardingFailure(error))
                }
                refresh()
            }
        }
    }

    /** 녹음에 동의한, 이 차가 참가시킨 사람의 토큰. 콘텐츠 기록은 기록본처럼 동의한 참가자만 본다. */
    private fun viewer(): String? = s.trip?.people?.firstOrNull { it.consent && it.id in tokens }?.let { tokens[it.id] }

    private fun contentScope(): ContentScope? {
        val t = s.trip ?: return null
        if (s.offPending || retentionExpired(t.createdAt, System.currentTimeMillis(), retentionMs)) return null
        return viewer()?.let { ContentScope(t.code, t.generation, it) }
    }

    private fun clearTranscript() {
        transcriptRequest++; transcriptOf = null; transcript = emptyList(); transcriptAsks = emptySet(); transcriptPlaces = emptyList(); transcriptLoading = false; transcriptNote = ""
    }

    private fun loadTranscript() {
        val scope = contentScope() ?: run { clearTranscript(); return }
        if (transcriptLoading) return
        val request = ++transcriptRequest
        transcriptOf = scope; transcriptLoading = true; transcriptNote = ""
        val url = server
        bg({ parseTranscript(Server(url).transcript(scope.code, scope.token)) }) { result ->
            if (isDestroyed || request != transcriptRequest || contentScope() != scope) return@bg
            transcriptLoading = false
            result.onSuccess { data ->
                if (data.generation != scope.generation) { clearTranscript(); refresh(); return@onSuccess }
                transcript = data.lines; transcriptAsks = data.asks; transcriptPlaces = data.places
            }.onFailure {
                transcript = emptyList()
                transcriptNote = "대화를 불러오지 못했어요 · ${reason(it)}"
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
    // 동승 연결은 주차 중에만, 왼쪽 무대 전체를 쓴다.

    // 녹음 시계(A D17–D20 '00:12:48'): 실제로 받아 적는 동안만 흐르고 멈추면 그 자리에 선다. 여행마다 prefs "recClock"({여행}:{ms}) 하나에 남긴다
    private var recordedMs by mutableLongStateOf(0L)
    private var recordedTrip: String? = null
    private var profileMenu by mutableStateOf(false) // 머리 줄 '내 얼굴' 프로필 메뉴(2200:5852 · 2257:5780)
    private var menuShell by mutableStateOf(Shell.RIDE) // 메뉴를 연 머리 줄의 틀(자리·좁은/넓은 메뉴)
    private var menuFace by mutableIntStateOf(R.drawable.char_basic)
    private var familyJump by mutableStateOf<FamilyJump?>(null) // 메뉴 → 가족 흐름 C16 groups·C16B
    private var logoutAsk by mutableStateOf(false) // 로그아웃 확인(2220:5864)
    // 그룹 여행 참가자의 프로필 캐릭터(참가자 id → 'glasses' 등). 여행 문서에는 없어 콘텐츠 기록의 members에서 한 번 받는다
    private var memberChars by mutableStateOf(emptyMap<String, String>())
    private var memberCharsOf: String? = null

    /**
     * 여행 화면(시안 A D17–D20·C44·C20): 머리 줄(주행 중 '연결됨' + 오른쪽 끝 '내 얼굴', 주차 중 '주차 중  P'), 세 탭, 선택한 탭의 본문.
     * 주행 제한 중(T11)에는 함께 타는 중·대화 기록만 열리고, 반쪽 창(841 × 1210)을 기준으로 칸을 고정한다. 화면 조각은 Drive.kt·Arrival.kt·TranscriptScreen.kt.
     */
    @Composable
    private fun TripScreen(raw: Trip) {
        BackHandler(boarding.page != BoardingPage.HIDDEN) {
            if (boarding.page == BoardingPage.PEOPLE) closeBoarding() else openBoarding()
        }
        val mockDriving = f4Mock in MOCK_DRIVING // mock: 주행 시연은 주행 중 모양, 시연 여행은 서버에 없어 머리 줄은 '연결됨'으로 둔다
        val parked = !carStatus.restricted && !mockDriving
        val scope = contentScope()
        // 자리 캐릭터: 그룹 여행이면 구성원의 프로필 캐릭터(시안처럼), 손님은 자리 순서. mock은 시안 A의 캐릭터
        LaunchedEffect(raw.code, scope?.token, raw.people.size) {
            if (f4Mock != null || scope == null || raw.people.none { it.profile } || memberCharsOf == "${raw.code}:${raw.people.size}") return@LaunchedEffect
            val url = server
            bg({ parseContentTrip(JSONObject(Server(url).contents(raw.code, scope.token))).members.associate { it.id to it.character }.filterValues { it.isNotBlank() } }) { r ->
                r.onSuccess { memberChars = it; memberCharsOf = "${raw.code}:${raw.people.size}" }
            }
        }
        val chars = if (f4Mock != null) MOCK_CHARS else memberChars
        val t = remember(raw, chars) { raw.copy(people = raw.people.map { p -> chars[p.id]?.let { p.copy(character = it) } ?: p }) }
        val rolling = s.recording && !muted && handoff.state == Handoff.State.OFF && Live.mic == Mic.ON
        LaunchedEffect(t.code, rolling) {
            if (recordedTrip != t.code) {
                recordedTrip = t.code
                recordedMs = prefs.getString("recClock", null)?.takeIf { it.substringBeforeLast(':') == t.code }?.substringAfterLast(':')?.toLongOrNull() ?: 0L
            }
            if (!rolling) return@LaunchedEffect
            val base = recordedMs; val since = android.os.SystemClock.elapsedRealtime()
            while (true) { // 1초에 한 번 글자만 바꾼다
                kotlinx.coroutines.delay(1000 - (android.os.SystemClock.elapsedRealtime() - since) % 1000)
                recordedMs = base + android.os.SystemClock.elapsedRealtime() - since
                prefs.edit().putString("recClock", "${t.code}:$recordedMs").apply()
            }
        }
        LaunchedEffect(destination, scope, afterStart) {
            if (destination == Destination.CONVERSATION || (destination == Destination.SHORTS && afterStart != null)) loadTranscript()
        }
        val b = mockBrief() ?: brief?.takeIf { vehicleParked() && offer?.stage.let { it == null || it == Offer.Stage.FINDING } } // 실제 P이고 제한이 풀린 동안만, 휴게소 제안이 먼저
        // 도착 브리핑(C20)과 좌석 배정·참석 QR(C16B·C16C·C16 guestInvite)은 주차 틀('주차 중  P')
        val shell = tripShell(parked, destination == Destination.RIDE && (b != null || boarding.page != BoardingPage.HIDDEN), destination == Destination.SHORTS,
            talk = destination == Destination.CONVERSATION)
        // 여행 화면의 '내 얼굴'은 이 여행에서 내 자리 캐릭터(없으면 계정 캐릭터)
        val myFace = mePerson(t.people)?.takeIf { it.character.isNotBlank() }?.let(::faceRes) ?: charDrawable(onboarding.character)
        CompositionLocalProvider(LocalMe provides Me(myFace, LocalMe.current.open)) {
        Box(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().padding(horizontal = shell.padH, vertical = shell.padV), verticalArrangement = Arrangement.spacedBy(shell.gap)) {
                TripHeader(shell, listening = s.recording && Live.mic == Mic.ON && !muted && handoff.state == Handoff.State.OFF)
                TripTabs(Destination.entries.map { it.label }, destination.ordinal, { parked || it != Destination.SHORTS.ordinal },
                    height = if (shell == Shell.TALK) 80.dp else 76.dp, style = if (shell == Shell.TALK) TalkTabText else CarText.Label, onSelect = { i ->
                        // 시안 탭 행선: 함께 타는 중 → C17(주차 중이면 C16 groups), 대화 기록 → C44, 콘텐츠 기록 → C33(같은 탭을 다시 눌러도 C33)
                        val tab = Destination.entries[i]
                        closeBoarding()
                        if (tab == Destination.RIDE) goRide() else { afterStart = null; destination = tab; shortsVisit++ }
                    })
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    when {
                        boarding.page != BoardingPage.HIDDEN && parked -> BoardingPanel(boarding, s, carStatus.seats, Modifier.fillMaxSize(), ::boardingAction)
                        destination == Destination.CONVERSATION -> Conversations(t, Modifier.fillMaxSize())
                        destination == Destination.SHORTS && parked && afterStart != null -> AfterTripTab(t, afterStart!!, Modifier.fillMaxSize())
                        destination == Destination.SHORTS && parked -> ShortsLibrary(t, Modifier.fillMaxSize())
                        b != null -> ArrivalBrief(b.place, b.final, b.arrivalItems ?: placeAsks(b.place, todoList), if (f4Mock != null) F4Mock.people else t.people,
                            onMain = { arrivalMain(b) }, modifier = Modifier.fillMaxSize(), details = if (f4Mock == "final") F4Mock.lodgeDetails else emptyMap())
                        else -> RideOverview(t, Modifier.fillMaxSize())
                    }
                }
            }
        }
        }
    }

    /**
     * 프로필 메뉴(모든 화면 하나): 주행 창은 좁은 메뉴(2200:5852, 머리 줄 아래 12), 주차 화면은 1682 폭 메뉴(2257:5780, 위 120·오른쪽 45).
     * 동승 그룹 변경 → C16 groups, 좌석 배정 → 여행 중이면 이 여행의 자리(BoardingPanel), 아니면 C16B, 갤러리 바로가기 → C33, 로그아웃 → 확인(2220:5864).
     */
    @Composable
    private fun BoxScope.MenuOverlay(t: Trip?) {
        val people = t?.people.orEmpty()
        val token = profileToken ?: account
        val url = server
        // 그룹 칸은 여행 제목이 아니라 그룹 이름(시안 '우리 가족'). 가족 그룹 이름을 한 번 읽는다
        LaunchedEffect(token, url) { if (token != null && menuGroup == null) bg({ Server(url).groups(token) }) { r -> r.onSuccess { gs -> menuGroup = gs.firstOrNull { it.kind == "family" }?.name } } }
        ProfileMenu(
            name = onboarding.name.ifBlank { mePerson(people)?.name.orEmpty() }.ifBlank { "내 프로필" }, face = menuFace, group = menuGroup ?: "우리 가족",
            people = people, driving = carStatus.restricted || f4Mock in MOCK_DRIVING,
            // 좁은 창 2200:5852 위 92·오른쪽 37, 넓은 창 2257:5780 위 120·오른쪽 45(= 머리 줄 아래, 여백 + 5)
            top = menuShell.padV + menuShell.head, end = menuShell.padH + 5.dp,
            // 주행 창(C17m 2206:5852)에서는 메뉴를 연 채로도 아래 녹음 막대의 ●·■가 눌린다
            keepBottom = if (menuShell == Shell.RIDE && t != null) menuShell.padV + 136.dp else 0.dp,
            onClose = { profileMenu = false },
            onGroup = { profileMenu = false; closeBoarding(); familyJump = FamilyJump.GROUPS; familyOpen = true },
            onSeats = {
                profileMenu = false
                if (t != null && !familyOpen) { destination = Destination.RIDE; openBoarding() } else { familyJump = FamilyJump.SEATS; familyOpen = true }
            },
            onGallery = { profileMenu = false; familyOpen = false; closeBoarding(); afterStart = null; destination = Destination.SHORTS; shortsVisit++ }, // C33
            onLogout = { profileMenu = false; logoutAsk = true },
        )
    }

    /**
     * 로그아웃(2220:5864·2257:5770 확인 → C01): 이 차의 계정 토큰을 지우고 시작 화면(온보딩)을 다시 연다. 여행·참가자 토큰·동의는 계정과 따로라
     * 그대로 두지만, 계정이 없으면 바닥이 여행 화면보다 시작 화면(C01)을 먼저 그린다.
     * ponytail: 계정 토큰 키("account")를 여기서 지운다. 흐름 F1이 Onboarding.logout()을 두면 그것으로 바꾼다.
     */
    private fun logout() {
        prefs.edit().remove("account").apply()
        profileToken = null; menuGroup = null; familyOpen = false
        onboarding.reopen()
    }

    /**
     * 함께 타는 중(C17 계열: C17·C17p·C19·C19p·C21·C21p, D 시연판도 같은 모양): 가운데 칸(방금 받아 적은 말 / 도착 전 카드 C19 / 휴게소 제안)
     * → 일행 → 아래 녹음 막대(⏸·● · 경과 시간 · 파형 · ■). 기록 전·마친 여행도 같은 틀이고, 그 상태는 가운데 칸 제목 자리에 쓴다.
     */
    @Composable
    private fun RideOverview(t: Trip, modifier: Modifier) {
        val mock = f4Mock?.takeIf { it in MOCK_DRIVING } // mock: 주행 중 시연(C17·C17p·resumed·C19·C19p·C21·finalNear·finalPaused)
        val parked = !carStatus.restricted && mock == null
        heardTick // 말한 사람이 바뀌면 다시 그린다
        val sp = speakers?.takeIf { it.trip == t.code }
        val talking = Live.recent.lastOrNull()?.takeIf { s.recording && !muted } // 방금 받아 적은 말의 좌석 구역(T37)과 말한 사람
        val ended = t.status == "ended" // 폰의 '여행 끝내기'나 최종 목적지에서 마친 여행(시안 2026:2410). 녹음은 하지 않는다(Session.withTrip)
        val mockPaused = mock?.endsWith("Paused") == true
        // mock: 시연 목업도 시간이 흐르고(일시정지면 멈춤, prefs에 남기지 않음) 파형은 이 차 마이크의 실제 소리를 따른다.
        // 수음 서비스가 마이크를 쥐고 있으면(Live.mic ON) 그쪽이 Live.levels를 민다 — 마이크를 둘이 다투지 않게 그때는 열지 않는다.
        var mockMs by remember(mock) { mutableLongStateOf(if (mock != null) mockClock() else 0L) }
        LaunchedEffect(mock, mockPaused) {
            if (mock == null || mockPaused) return@LaunchedEffect
            val base = mockMs; val since = android.os.SystemClock.elapsedRealtime()
            while (true) { // 1초에 한 번 글자만 바꾼다(실제 녹음 시간과 같은 방식)
                kotlinx.coroutines.delay(1000 - (android.os.SystemClock.elapsedRealtime() - since) % 1000)
                mockMs = base + android.os.SystemClock.elapsedRealtime() - since
            }
        }
        DisposableEffect(mock, mockPaused, Live.mic) {
            val meter = if (mock != null && !mockPaused && Live.mic != Mic.ON)
                // MicLevels는 meterLevel(−55~−5 dBFS를 0..1) 값을 준다: dB로 되돌려 넣는다(시연 목업만 첨두가 아닌 RMS)
                MicLevels { v -> main.post { Live.levels = (Live.levels + (v * 50f - 55f)).takeLast(WAVE_BARS) } }.also { it.start() } else null
            onDispose { meter?.stop() }
        }
        // 시안에 없는 상태(Gleo·마이크·동의 대기·철회·연결)와 알릴 말은 받아 적은 말 카드의 제목 자리에(C17에는 상태 칸이 없다)
        val hold = if (mock != null) null else driveNote(s.recording, muted, handoff.state, Live.mic, Live.why, s.offPending, s.waiting, s.gear == "P",
            t.people.filterNot { it.consent }.map { it.name }, ended = ended)
        val note = s.note.ifBlank { arrivalNote }.ifBlank { if (mock == null && !s.online) "서버 연결을 기다리고 있어요" else "" }
        // 도착 전 카드: 내비가 다음 장소까지 5분 이하라고 알렸고 그 장소의 서버 할 일이 있을 때(C19, 최종 목적지도 C19 모양)
        val nearAsks = (mockApproach() ?: near?.takeIf { it.trip == t.code && !parked })?.let { a ->
            (if (mock != null) mockNearAsks() else placeAsks(a.place, todoList)).takeIf { it.isNotEmpty() }
        }
        val o = offer?.takeIf { it.stage != Offer.Stage.FINDING }
        val recording = mock != null || s.recording && !ended
        val paused = if (mock != null) mockPaused else muted || ended // 멈춤과 마친 여행: '멈추기 전 마지막 대화'(C17p)
        val live = if (mock != null) !mockPaused else s.recording && !muted && handoff.state == Handoff.State.OFF && Live.mic == Mic.ON
        // 이 차가 받아 적은 말이 없으면(앱을 다시 켰거나 시드한 여행) 서버 기록본의 마지막 두 줄과 그 말한 사람
        val rows = if (mock != null) mockHeard(t.people) else Live.recent.asReversed().map { u ->
            val who = sp?.get(u.seq)?.who?.let { id -> t.people.firstOrNull { it.id == id } }
            HeardRow(heardMeta(who?.name, who?.seat, u.seatZone), u.text, null, who?.let(::faceRes))
        }.ifEmpty {
            transcript.takeLast(2).asReversed().map { l ->
                val who = t.people.firstOrNull { it.id == l.participantId }
                HeardRow(heardMeta(who?.name, who?.seat, null), l.text, null, who?.let(::faceRes))
            }
        }
        LaunchedEffect(t.code, Live.recent.isEmpty()) { if (mock == null && Live.recent.isEmpty() && transcript.isEmpty()) loadTranscript() }
        // 제목: 받아 적는 중 '방금 받아 적은 말 N건'(C17), 멈춤·마친 여행 '멈추기 전 마지막 대화'(C17p)
        val title = when {
            note.isNotBlank() -> note
            paused && recording || ended -> "멈추기 전 마지막 대화"
            hold != null -> hold
            else -> "방금 받아 적은 말 ${if (mock != null) 42 else Live.count}건"
        }
        RideLayout(
            middle = { m ->
                when {
                    o != null -> OfferCard(o, m)
                    nearAsks != null -> NearCard(nearRows(nearAsks), m)
                    else -> HeardCard(title, rows, dim = paused && (recording || ended), modifier = m)
                }
            },
            seats = { SeatCard(t.people, carStatus, if (mock != null) F4Mock.talking(mock) else talking?.let { u -> sp?.get(u.seq)?.who }) },
            bar = {
                RecordBar(driveButton(recording, paused, s.agreed && !ended), live, recordClock(if (mock != null) mockMs else recordedMs), { Live.levels },
                    onControl = { if (mock == null) recordingAction() }, onStop = ::stopTrip)
            },
            modifier = modifier,
        )
    }

    /**
     * 도착 브리핑(C20)의 '계속'. 경유지는 브리핑을 닫고(→ C21, 내비는 다음 장소로), 최종 목적지는 서버 여행을 마친 뒤(PATCH status ended, 폰의
     * '여행 끝내기'와 같은 요청) 여행 마무리(C22)를 연다 — C21 다음이 C22다. 실패하면 브리핑에 이유를 남긴다.
     */
    private fun arrivalMain(b: Brief) {
        if (f4Mock != null) { f4Mock = null; if (b.final) { afterStart = AfterStep.UPLOAD; destination = Destination.SHORTS }; return } // mock: 시연은 화면만 넘긴다
        if (!b.final) { brief = null; return }
        val scope = todoScope() ?: return
        bg({ Server(scope.server).endTrip(scope.trip, scope.token) }) { r ->
            r.onSuccess { got -> s = s.withTrip(keep(got)); brief = null; closeBoarding(); afterStart = AfterStep.UPLOAD; destination = Destination.SHORTS }
                .onFailure { arrivalNote = "여행을 마치지 못했어요 · ${reason(it)}" }
        }
    }

    /**
     * ■ 녹화 종료(C17·C19 → C22): 이 여행을 마친다(PATCH status ended — 폰의 '여행 끝내기'·최종 도착 '계속'과 같은 요청). 주차 중이면 바로
     * 여행 마무리(C22)를, 주행 중이면 주차하는 대로 연다(콘텐츠 기록은 주차 중에만, T11). 못 마치면 그 까닭을 가운데 칸 제목에 남긴다.
     */
    private fun stopTrip() {
        if (f4Mock != null) { f4Mock = null; return } // mock: 시연은 화면만 넘긴다
        val scope = contentScope() ?: return
        val url = server
        bg({ Server(url).endTrip(scope.code, scope.token) }) { r ->
            r.onSuccess { got ->
                s = s.withTrip(keep(got))
                if (!carStatus.restricted) { closeBoarding(); afterStart = AfterStep.UPLOAD; destination = Destination.SHORTS } else wrapWhenParked = true
            }.onFailure { s = s.copy(note = "여행을 마치지 못했어요 · ${reason(it)}") }
        }
    }

    // mock: F4 화면 확인용(디버그 빌드의 --es f4 …). 실제 값은 내비 남은 시간과 서버 할 일이다
    private fun mockApproach(): Approach? = when (f4Mock) {
        "near", "nearPaused" -> Approach("F4DEMO", "하나로마트", 3, 170)
        "finalNear" -> Approach("F4DEMO", "강릉 숙소", 1, 60, final = true)
        "finalPaused" -> Approach("F4DEMO", "강릉 숙소", 1, 60, final = true)
        else -> null
    }
    // 도착 전 카드의 시안 글: C19·C19p '화장실 가기 / 장보기 / 쓰레기 정리하기', finalNear·finalPaused '화장실 가기 / 고기 냉장 보관 / 짐과 쓰레기 챙기기'
    private fun mockNearAsks(): List<SharedTodo> {
        fun todo(id: String, category: String, title: String, items: List<String>, by: String) =
            SharedTodo(id, "숙소", title, "pending", 0, emptyList(), category, items.map { TodoItem(it, null) }, listOf(by), title)
        return if (f4Mock?.startsWith("final") == true) listOf(F4Mock.lodge[0], todo("f2", "remember", "고기 냉장 보관", listOf("냉장 보관"), "mom"),
            todo("f3", "bring", "짐과 쓰레기 챙기기", listOf("짐", "쓰레기"), "dad"))
        else F4Mock.martNear.take(2) + todo("n4", "remember", "쓰레기 정리하기", listOf("쓰레기"), "dad")
    }
    // C17 계열 시안의 경과 시간 '19:11'과 방금 받아 적은 말 두 줄(C17·C17p·resumed / C21·C21p, 새 것이 위)
    private fun mockClock(): Long = 1_151_000L
    private fun mockHeard(people: List<Person>): List<HeardRow> =
        (if (f4Mock == "driveContinue") listOf("haeun" to "우리 내일도 같이 타면 안 돼?", "mom" to "숙소에 가서 맛있게 먹자")
        else listOf("seojun" to "아빠, 바다는 왜 짜?", "mom" to "마트에서 고기랑 과일도 사 가자"))
            .mapNotNull { (id, text) -> people.find { it.id == id }?.let { p -> HeardRow(heardMeta(p.name, p.seat, null), text, null, faceRes(p)) } }
    private fun mockBrief(): Brief? = when (f4Mock) {
        "mart" -> Brief("하나로마트", F4Mock.mart, final = false)
        "final" -> Brief("강릉 숙소", F4Mock.lodge, final = true)
        else -> null
    }

    /**
     * 대화 기록(C44). 지금 여행의 서버 기록을 채팅으로 바로 보인다. 추천 장면 고르기는 콘텐츠 기록의 장면 고르기(C23).
     * 주행 중(시안 2026:2308·2358)은 읽기만: 장면 고르기 없이 가장 새 줄을 보이고 '함께 타는 중으로'만 둔다. '(나)'는 운전석의 프로필 참가자.
     */
    @Composable
    private fun Conversations(t: Trip, modifier: Modifier) {
        val scope = contentScope()
        TranscriptScreen(t, transcript, transcriptPlaces, transcriptLoading,
            when {
                scope == null -> "대화 기록에 동의한 참가자만 볼 수 있어요"
                transcriptNote.isNotEmpty() -> transcriptNote
                transcriptLoading -> "대화를 불러오고 있어요"
                else -> "" // 시안 C44는 목록 밑에 상태 줄이 없다. 불러오기·동의·오류일 때만 적는다
            },
            // 주행 중에도 C44 모양이고, 장면 고르기(C23)만 주차 뒤에(T11)
            canPick = scope != null && s.online && !carStatus.restricted,
            onPick = { closeBoarding(); afterStart = AfterStep.SELECT; destination = Destination.SHORTS }, modifier = modifier, // 추천 장면 3개(C23)
            me = mePerson(t.people)?.id)
    }

    /** 여행 마무리·추천 장면 고르기·생성·결과(C22–C32). 후보는 차 안 규칙, 고른 장면은 POST /moments, 소리는 이 차의 클립 올리기(clips). */
    @Composable
    private fun AfterTripTab(t: Trip, start: AfterStep, modifier: Modifier) {
        if (!appVisible || carStatus.restricted) return // 주차 중에만(T11). 주차했는데 여행이 아직 driving이어도 빈 본문이 아니라 C22–C32
        val scope = contentScope()
        val url = server
        val lines = remember(t.code, t.generation, transcript, Live.count) { afterLines(this, t, transcript) }
        androidx.compose.runtime.key(t.code, t.generation, start) {
            AfterTrip(t, lines, url, scope?.token, start,
                // 계속해도 되는가(바뀌면 멈춤): 같은 여행·세대·서버·참가자 토큰, 모두 동의, 주행 아님(종료는 마무리 단계라 됨)
                allowed = { !isDestroyed && scope != null && contentScope() == scope && server == url && s.trip?.let { it.code == t.code && it.generation == t.generation && it.people.all { p -> p.consent } && it.status != "driving" } == true },
                // 지금 할 수 있는가(잠깐 거짓이면 기다림): 앱이 보임, 서버 연결, 주차
                ready = { appVisible && s.online && !carStatus.restricted },
                onContents = { afterStart = null }, modifier = modifier)
        }
    }

    /** 콘텐츠 기록 탭(F6, Contents.kt: 갤러리·타임라인·지도). */
    @Composable
    private fun ShortsLibrary(t: Trip, modifier: Modifier) {
        if (!appVisible || carStatus.restricted) return // 콘텐츠 기록은 주차 중에만(T11). 주차했는데 여행이 아직 driving이어도 C33
        val scope = contentScope()
        val url = server
        androidx.compose.runtime.key(url, t.code, t.generation, scope?.token, shortsVisit) {
            ContentsRecord(url, t.code, scope?.token,
                canRead = { appVisible && !isDestroyed && s.online && !carStatus.restricted && scope != null && contentScope() == scope && server == url && handoff.state == Handoff.State.OFF },
                canPlay = { appVisible && !isDestroyed && !carStatus.restricted && handoff.state == Handoff.State.OFF },
                onRide = ::goRide, // C33 '우리 가족 N명' → 함께 타는 중(주차 중이면 C16 groups)
                onActiveChange = ::shortStudioActiveChanged, members = t.people.size, modifier = modifier)
        }
    }

    /** 경유지 제안(T9, C2). 주행 중에도 한 번 누르는 큰 단추 둘만. 거리·시간은 그곳까지이고 들르면 늘어나는 시간이 아니다. */
    @Composable
    private fun OfferCard(o: Offer, modifier: Modifier) {
        val c = MaterialTheme.colorScheme
        Card(Tone.Accent, modifier) {
            when (o.stage) {
                Offer.Stage.ASKING -> {
                    Text("${o.stop?.spoken}에 들를까요?", fontSize = 36.sp, lineHeight = 44.sp, fontWeight = FontWeight.Bold)
                    Text(listOf(distanceLabel(o.meters, o.seconds), "부탁 ${o.requests.size}건").filter { it.isNotEmpty() }.joinToString(" · "), color = c.onSurfaceVariant)
                    Spacer(Modifier.weight(1f))
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        // 그린 뒤에 묶인 부탁이 빠지지 않게 누른 때의 제안으로 부른다
                        Button({ offer?.let(::accept) }, Modifier.weight(1f).height(80.dp), shape = RoundedCornerShape(24.dp)) { Text("경유지로 추가", fontSize = 28.sp) }
                        OutlinedButton({ offer?.let { later(it) } }, Modifier.weight(1f).height(80.dp), shape = RoundedCornerShape(24.dp)) { Text("나중에", fontSize = 28.sp) }
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

    @Composable
    private fun Card(tone: Tone = Tone.Plain, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) = CarCard(tone, modifier, content = content)
}

/** mock: 시안 A의 자리 캐릭터(아빠 안경·엄마 힐링·서준 캡모자·하은 기본). */
private val MOCK_CHARS = mapOf("dad" to "glasses", "mom" to "healing", "seojun" to "cap", "haeun" to "basic")

/** mock: 도착 전 시연 값(주행 중 모양으로 그림). */
private val MOCK_DRIVING = setOf("near", "nearPaused", "finalNear", "finalPaused", "drive", "drivePaused", "driveResumed", "driveContinue") // drive…: 시연 17–19·22(T150)
