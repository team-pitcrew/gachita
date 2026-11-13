package io.github.teampitcrew.gachita

import android.Manifest
import android.content.SharedPreferences
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
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

private const val DEFAULT_SERVER = "http://10.0.2.2:8787" // 에뮬레이터에서 본 Mac의 make run
private const val POLL_MS = 10_000L // 웹앱은 2초. 차에서는 주행 중 자원 기준(CPU 5% 미만)을 생각해 길게 둔다
private const val TITLE = "같이타 가족 여행"

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
    private var visible = false // onStart ~ onStop
    private var resumed = false // 우리 화면이 앞: 마이크 서비스는 이때만 시작할 수 있다(T10)
    private var askedMic = false
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
        if (!s.recording || code == null) {
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
        // 실행 인자(--es server, --ei widthDp)는 디버그 빌드에서만 받는다. 밖에서 연 화면이 서버 주소를 바꾸지 못하게
        val debug = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (debug) intent.getStringExtra("server")?.let { prefs.edit().putString("server", it).apply() }
        server = prefs.getString("server", null) ?: DEFAULT_SERVER
        device = prefs.getString("device", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("device", it).apply() }
        // 앱을 다시 켜도, 서버에 닿지 않아도 마지막으로 받은 여행과 끄기 대기를 이어 보여 준다
        s = Session.restore(prefs.getString("trip", null), prefs.getBoolean("offPending", false), prefs.getBoolean("started", false))
        s.trip?.let { Live.outbox(this, it.code) } // 앱을 다시 켜도 받아 적은 말과 순번을 이어 보여 준다
        car = Car(this) { carStatus = it; Live.gear = it.gear; s = s.withGear(it.gear) }
        car.start()
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors, typography = CarType) {
                ProvideTextStyle(TextStyle(fontSize = 24.sp)) {
                    // ponytail: 에뮬레이터는 창을 나누지 않아 반쪽 창을 --ei widthDp 841로 흉내 낸다. 실제 분할 창 확인은 실차에서
                    val w = if (debug) intent.getIntExtra("widthDp", 0) else 0
                    Surface(if (w > 0) Modifier.fillMaxHeight().width(w.dp) else Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                        val t = s.trip
                        if (t == null) Setup() else TripScreen(t)
                    }
                }
            }
        }
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
        main.removeCallbacks(tick)
        if (!isChangingConfigurations) CaptureService.stop(this) // 동의를 확인할 화면이 없어지면 수음도 멈춘다
        car.stop(); io.shutdown(); super.onDestroy()
    }

    /** 통신은 한 줄로 차례대로 돌리고 결과만 메인 스레드로 돌려받는다. */
    private fun <T> bg(work: () -> T, done: (Result<T>) -> Unit) = io.execute { val r = runCatching(work); main.post { done(r) } }

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

    /** 1682 × 1210 창은 두 칸, 반쪽(약 841 × 1210)은 한 칸에 기록 → 가족 → 부탁 → 조작 순서로 쌓는다(frontend/spec/car.md). */
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
            if (s.recording) {
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
            if (Live.pending > 0) Text("서버에 보내지 않고 이 차에 보관 중 ${Live.pending}건", color = c.onSurfaceVariant, fontSize = 20.sp)
        }
    }

    @Composable
    private fun Controls(t: Trip) {
        val c = MaterialTheme.colorScheme
        Card {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("대화 기록 동의", fontSize = 30.sp, fontWeight = FontWeight.Bold)
                    Text("기본값은 꺼짐 · 주차 중에만 켤 수 있어요", color = c.onSurfaceVariant, fontSize = 20.sp)
                }
                Switch(s.agreed, { if (it) turnOn() else turnOff() }, enabled = !s.busy)
            }
            if (s.note.isNotEmpty()) Text(s.note, color = c.error)
        }
        Card {
            if (s.online) Text("서버에 연결됐어요", color = c.tertiary)
            else Text("연결이 끊겼어요 · 마지막으로 확인한 정보예요", color = c.error)
            Text("기어 ${s.gear ?: "모름"} · 내비 ${if (carStatus.navi) "연결됨" else "연결 안 됨"} · 음성 ${if (carStatus.voice) "준비됨" else "준비 안 됨"}", color = c.onSurfaceVariant, fontSize = 20.sp)
            Text("여행 코드 ${t.code}", color = c.onSurfaceVariant, fontSize = 20.sp)
        }
        OutlinedButton(::newTrip, Modifier.heightIn(min = 64.dp), enabled = !s.agreed && !s.busy) { Text("새 여행 만들기") }
    }

    @Composable
    private fun Card(content: @Composable () -> Unit) {
        val c: ColorScheme = MaterialTheme.colorScheme
        Surface(Modifier.fillMaxWidth(), RoundedCornerShape(20.dp), color = c.surface, border = BorderStroke(1.dp, c.outline)) {
            Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { content() }
        }
    }
}
