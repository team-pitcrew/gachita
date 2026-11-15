package io.github.teampitcrew.gachita

import android.util.Log
import android.Manifest
import android.content.ActivityNotFoundException
import android.view.View
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.delay
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/*
 * 차 계정·온보딩(T142, 최종 시안 C01–C08, 피그마 2004:57 · T156에서 11/15 시안으로 다시 옮김). 주차 중 전체 창(1682 × 1210)에만 진행한다(주행 제한이면 여행이 없을 때 C01만 단추를 잠가 보인다).
 * 시작 → 계정 만들기·로그인(이 차의 프로필 토큰) → 기록 동의 → 이름·캐릭터 → 사진 → 15초 목소리 → 등록 완료.
 * 목소리는 차 마이크로 15초를 모아 Voice.kt의 embed(pcmSamples(...))로 값(112차원)을 만들고 값만 올린다(ADR-0023). 소리는 차를 떠나지 않는다.
 * 계정 동의가 켜져 있지 않으면 마이크를 열지 않는다.
 * 마치면 가족 흐름(F2, Family.kt)으로 간다. 디버그 실행 인자 --ez onboarding false로 건너뛴다(시연·e2e 스크립트).
 */

const val VOICE_SECONDS = 15
const val MIN_VOICE_SECONDS = 5 // '녹음 완료'가 눌리는 최소 길이. 서버는 1~20초를 받는다
// 시안 C06·C07 파형(2005:2647) 막대 64개의 높이(dp, 칸 높이 126). 녹음 중의 실제 소리 막대도 이 범위(가장 낮은 10 ~ 가장 높은 103.6)로 그린다.
private val BARS = listOf(33.4f, 64f, 94.6f, 29.8f, 60.4f, 91f, 26.2f, 56.8f, 87.4f, 22.6f, 53.2f, 83.8f, 19f, 49.6f, 80.2f, 15.4f, 46f, 76.6f, 11.8f, 42.4f, 73f, 103.6f, 38.8f, 69.4f, 100f, 35.2f, 65.8f, 96.4f, 31.6f, 62.2f, 92.8f, 28f, 58.6f, 89.2f, 24.4f, 55f, 85.6f, 20.8f, 51.4f, 82f, 17.2f, 47.8f, 78.4f, 13.6f, 44.2f, 74.8f, 10f, 40.6f, 71.2f, 101.8f, 37f, 67.6f, 98.2f, 33.4f, 64f, 94.6f, 29.8f, 60.4f, 91f, 26.2f, 56.8f, 87.4f, 22.6f, 53.2f)
private const val BAR_MIN = 10f
private const val BAR_MAX = 103.6f
// 시안 C04의 캐릭터 순서(안경·힐링·캡모자·기본)와 나머지. 값은 서버 character(웹과 같은 이름).
private val CHARS = listOf("glasses" to R.drawable.char_glasses, "healing" to R.drawable.char_healing, "cap" to R.drawable.char_cap, "basic" to R.drawable.char_basic,
    "travel" to R.drawable.char_travel, "game" to R.drawable.char_game, "sport" to R.drawable.char_sport, "pet" to R.drawable.char_pet, "camping" to R.drawable.char_camping, "office" to R.drawable.char_office)

fun charDrawable(key: String): Int = CHARS.firstOrNull { it.first == key.removeSuffix("-small") }?.second ?: R.drawable.char_basic

class Onboarding(private val context: Context, private val prefs: SharedPreferences, private val server: () -> String) {
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val seal get() = Live.seal(context)

    var step by mutableStateOf<OnboardStep?>(null); private set
    var email by mutableStateOf("")
    var password by mutableStateOf("")
    var name by mutableStateOf("")
    var character by mutableStateOf("glasses")
    var photo by mutableStateOf<Bitmap?>(null); private set
    var profile by mutableStateOf<AccountProfile?>(null); private set
    var busy by mutableStateOf(false); private set
    var note by mutableStateOf(""); private set
    var heard by mutableStateOf(0.0); private set // 녹음한 초
    var levels by mutableStateOf(DoubleArray(0)); private set // 막대 칸마다 실제로 들어온 소리 크기(VoiceMeter)
    private var photoJpeg: ByteArray? = null
    private var recorder: VoiceRecorder? = null
    private var pcm: ByteArray? = null
    private var submitWhenStopped = false

    /** 이 차의 계정 토큰(암호화해 둠). */
    val token: String? get() = prefs.getString("account", null)?.let { runCatching { seal.unline(it) }.getOrNull() }
    private var skipped by mutableStateOf(prefs.getBoolean("onboardingSkipped", false))
    private var finished by mutableStateOf(prefs.getBoolean("onboardingDone", false))

    /** 처음 화면을 온보딩으로 덮을지. 여행이 있거나 주행 제한이면 MainActivity가 먼저 고른다. */
    val showing: Boolean get() = !skipped && !finished

    /** 처음 화면의 '계정·목소리'에서 다시 연다. */
    fun reopen(at: OnboardStep? = null) { skipped = false; finished = false; prefs.edit().putBoolean("onboardingSkipped", false).putBoolean("onboardingDone", false).apply(); step = null; start(at) }

    /** 디버그 실행 인자 --ez onboarding false(시연·e2e 스크립트가 처음 화면을 가족 흐름으로 본다). */
    fun skipForDebug() { skipped = true; prefs.edit().putBoolean("onboardingSkipped", true).apply() }

    private fun finish() { stopRecording(); finished = true; prefs.edit().putBoolean("onboardingDone", true).apply() }

    /** 단계를 정한다. 토큰이 있으면 서버에서 프로필을 읽어 빠진 단계부터. at: 동의를 마친 계정이면 그 단계로(목소리 먼저, T173 → C06). */
    fun start(at: OnboardStep? = null) {
        if (step != null) return
        val t = token ?: run { step = OnboardStep.WELCOME; return }
        step = OnboardStep.WELCOME
        work({ AccountApi(server()).me(t) }) { p -> adopt(p); (at?.takeIf { p.consent } ?: firstOnboardStep(p, true))?.let { step = it } ?: finish() }
    }

    fun go(next: OnboardStep) { note = ""; step = next }

    // 온보딩을 마친 계정으로 다시 켜면(start()를 부르지 않음) 머리 줄 얼굴·프로필 메뉴의 이름·캐릭터가 비어 있었다 — 한 번 읽어 둔다.
    // ponytail: onCreate가 서버 주소(디버그 인자)를 정한 뒤에 돌도록 main.post. MainActivity가 따로 부르게 되면 그쪽으로 옮긴다.
    init { main.post { val t = token; if (t != null && !showing) work({ AccountApi(server()).me(t) }) { adopt(it) } } }

    fun clearNote() { note = "" }

    private fun adopt(p: AccountProfile) {
        profile = p
        name = p.name
        character = p.character.removeSuffix("-small").ifEmpty { "glasses" }
    }

    private fun saveToken(t: String) { prefs.edit().putString("account", seal.line(t)).apply() }

    private fun <T> work(job: () -> T, ok: (T) -> Unit) {
        if (busy) return
        busy = true; note = ""
        io.execute {
            val r = runCatching(job)
            main.post {
                busy = false
                r.onSuccess(ok).onFailure { note = if (it is ApiError) failureText(it) else "연결이 끊겨서 보내지 못했어요" }
            }
        }
    }

    /** C02 '가입하고 계속': 가입, 이미 가입한 이메일이면 같은 칸으로 로그인(AccountApi.enter). login: 로그인 화면 '로그인하고 계속'(AccountApi.login). */
    fun submitAccount(login: Boolean = false) {
        if (!validEmail(email)) { note = "이메일 주소를 확인해 주세요"; return }
        if (!validPassword(password)) { note = "비밀번호는 8~72자로 적어 주세요"; return }
        val e = email.trim(); val pw = password; val url = server()
        if (busy) return
        busy = true; note = ""
        io.execute {
            val r = runCatching { if (login) AccountApi(url).login(e, pw) else AccountApi(url).enter(e, pw).first }
            main.post {
                busy = false
                r.onSuccess { (p, t) ->
                    saveToken(t); password = ""; adopt(p)
                    // 시안 C02 → C03. 새 계정은 동의부터, 이미 가입한 계정(로그인)은 빠진 단계만 — 다 있으면 온보딩을 끝내고 가족·그룹 화면
                    missingStep(p)?.let(::go) ?: finish()
                }.onFailure { note = accountError(it) }
            }
        }
    }

    /** C03: 계정 동의. */
    fun agree() { val t = token ?: return go(OnboardStep.SIGNUP); work({ AccountApi(server()).consent(t) }) { adopt(it); missingStep(it)?.let(::go) ?: finish() } }

    /** C04 '목소리 등록하기': 이름·캐릭터(와 C05에서 고른 사진)를 저장하고 목소리로. */
    fun saveProfile() {
        val t = token ?: return go(OnboardStep.SIGNUP)
        val n = name.trim().ifEmpty { note = "함께 타는 사람들에게 보일 이름을 적어 주세요"; return }.take(20)
        val c = character; val jpeg = photoJpeg; val url = server()
        work({ AccountApi(url).let { api -> jpeg?.let { api.photo(t, it) }; api.profile(t, n, c) } }) { adopt(it); photoJpeg = null; missingStep(it)?.let(::go) ?: finish() }
    }

    /** C05 '내 사진 선택': 기기 사진 보관함에서 고른 사진. 640px JPEG로 다시 그린다(위치 같은 덧붙은 정보가 빠짐). 고르면 C04로 돌아가 '목소리 등록하기'에서 함께 올린다. */
    fun picked(uri: Uri?) {
        uri ?: return
        io.execute {
            val r = runCatching {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                context.contentResolver.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, bounds) }
                var sample = 1
                while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 640) sample *= 2
                val raw = context.contentResolver.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) }
                    ?: error("사진을 읽지 못했어요")
                val s = minOf(1f, 640f / maxOf(raw.width, raw.height))
                val b = Bitmap.createScaledBitmap(raw, (raw.width * s).toInt().coerceAtLeast(1), (raw.height * s).toInt().coerceAtLeast(1), true)
                b to ByteArrayOutputStream().also { b.compress(Bitmap.CompressFormat.JPEG, 85, it) }.toByteArray()
            }
            main.post {
                r.onSuccess { (b, jpeg) -> photo = b; photoJpeg = jpeg; note = ""; if (step == OnboardStep.PHOTO) step = OnboardStep.PROFILE }
                    .onFailure { note = "이 사진은 읽지 못했어요. 다른 사진을 골라 주세요" }
            }
        }
    }

    /** C05 '캐릭터로 계속' → C04: 고른 사진을 올리지 않고 캐릭터로. */
    fun useCharacter() { photo = null; photoJpeg = null; go(OnboardStep.PROFILE) }

    fun noGallery() { note = "이 차에는 사진 보관함이 없어요. 사진 대신 캐릭터로 계속해요" }

    /** C06 → C07: 15초 녹음. 계정 동의가 켜져 있을 때만 마이크를 연다. */
    fun startRecording() {
        if (profile?.consent != true) { note = "기록 동의를 먼저 받아요"; step = OnboardStep.CONSENT; return }
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) { note = "마이크 권한이 없어 녹음할 수 없어요"; return }
        stopRecording()
        pcm = null; heard = 0.0; levels = DoubleArray(0); note = ""; submitWhenStopped = false
        val meter = VoiceMeter(BARS.size)
        val rec = VoiceRecorder({ s, level -> meter.add(s, level); val snap = meter.snapshot(); main.post { if (recorder != null) { heard = s; levels = snap } } }) { bytes, failed ->
            main.post {
                if (failed != null) { note = failed; step = OnboardStep.VOICE; recorder = null; return@post }
                pcm = bytes; heard = bytes.size / 2.0 / RATE; recorder = null
                submitWhenStopped = false; submitVoice() // 15초를 다 채웠거나 '녹음 완료'로 멈춤 → 올리고 C08(시안 C07 자동 → C08)
            }
        }
        recorder = rec
        step = OnboardStep.RECORDING
        rec.start()
    }

    fun stopRecording() { recorder?.cancel(); recorder = null }

    /** C07 '다시 녹음' → C06(녹음 전): 지금 녹음을 버리고 '녹음 시작'을 다시 누르게 한다(docs/car-frames.md 행선). */
    fun again() { stopRecording(); pcm = null; heard = 0.0; levels = DoubleArray(0); submitWhenStopped = false; go(OnboardStep.VOICE) }

    /** C07 '녹음 완료': 멈추고 차 안에서 값으로 바꿔 올린다. */
    fun submitVoice() {
        val t = token ?: return go(OnboardStep.SIGNUP)
        if (heard < MIN_VOICE_SECONDS || busy) return
        recorder?.let { r -> submitWhenStopped = true; r.finishNow(); return } // 녹음 중에 누르면 멈춘 뒤 다시 불린다
        val bytes = pcm ?: return
        if (profile?.consent != true) { step = OnboardStep.CONSENT; return }
        val url = server()
        work({
            val v = embed(pcmSamples(bytes)) ?: throw ApiError(400, "소리가 너무 짧아요")
            AccountApi(url).voice(t, v, bytes.size / 2.0 / RATE)
            // 둘째 값(강한 화자 값)도 올린다(StrongVoice.kt). 못 만들거나 못 올려도 등록은 된 것이다(1차 값으로 대조)
            runCatching { strongBody(context, bytes)?.let { AccountApi(url).strongVoice(t, it) } }.onFailure { Log.w("GachitaVoice", "둘째 값을 올리지 못함", it) }
            AccountApi(url).me(t)
        }) { p -> pcm = null; adopt(p); go(OnboardStep.DONE) }
    }

    /** C08 '가족 그룹 만들기'. */
    fun done() = finish()

    fun close() { stopRecording(); io.shutdown() }

}

// ---- 화면(원본 Figma 2004:57 C01–C08, 11/15 다시 읽음). 틀은 ParkedFrame, 조각은 CarDesign.kt(TitleBlock·InfoCard·CarField·CarButton) ----
// C02–C08 본문은 가운데 988 폭 한 줄(간격 24), C01은 '두 순간' 글 묶음 680 · 간격 80 · 보관 카드 400 × 550. 오른쪽 가족 카드는 11/15 시안에서 빠졌다.

/** driving: 주행 제한 중 여행이 없을 때. 진행한 단계와 상관없이 시작 화면(C01)만 보이고 단추는 잠근다(T11, 설정은 주차 중에만). */
@Composable
fun OnboardingScreen(o: Onboarding, driving: Boolean = false, onFamily: () -> Unit) {
    val c = MaterialTheme.colorScheme
    val ctx = LocalContext.current
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { o.picked(it) }
    val mic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { if (it) o.startRecording() }
    LaunchedEffect(o, driving) { if (!driving) o.start() }
    val step = if (driving) OnboardStep.WELCOME else o.step ?: OnboardStep.WELCOME
    // 기기 뒤로: 앞 화면이 있는 단계만 한 칸 뒤로(C02 → C01, 로그인 → C02, C05·C06 → C04, C07 → C06). 동의(C03) 뒤로는 이미 만든 계정이라 앱 기본(나가기)
    val back = when (step) { OnboardStep.SIGNUP -> OnboardStep.WELCOME; OnboardStep.LOGIN -> OnboardStep.SIGNUP; OnboardStep.PHOTO, OnboardStep.VOICE -> OnboardStep.PROFILE; OnboardStep.RECORDING -> OnboardStep.VOICE; else -> null }
    BackHandler(!driving && back != null && !o.busy) { if (step == OnboardStep.RECORDING) o.again() else o.go(back!!) }
    val p = o.profile
    val shownName = p?.name?.takeIf { it.isNotBlank() } ?: o.name
    // 원본에 없는 오류 글(입력·서버·사진·마이크)은 본문에 따로 두지 않고 2047:2276 알림으로 잠깐 보인다(CarToast)
    LaunchedEffect(o.note) { if (o.note.isNotEmpty()) { delay(toastMs(o.note)); o.clearNote() } }
    ParkedFrame(
        overlay = { CarToast(o.note) },
        bottom = {
            when (step) {
                OnboardStep.WELCOME -> CarButton("가치타 시작하기", enabled = !driving) { o.go(OnboardStep.SIGNUP) }
                OnboardStep.SIGNUP -> CarButton("가입하고 계속", enabled = !o.busy) { o.submitAccount() }
                OnboardStep.LOGIN -> CarButton("로그인하고 계속", enabled = !o.busy) { o.submitAccount(login = true) }
                OnboardStep.CONSENT -> CarButton("동의하고 계속", enabled = !o.busy) { o.agree() }
                OnboardStep.PROFILE -> CarButton("목소리 등록하기", enabled = !o.busy) { o.saveProfile() }
                OnboardStep.PHOTO -> CarButton("캐릭터로 계속") { o.useCharacter() } // 시안 행선: C05 → C04(저장은 C04 '목소리 등록하기')
                OnboardStep.VOICE -> CarButton("녹음 시작", enabled = !o.busy) {
                    if (ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) o.startRecording() else mic.launch(Manifest.permission.RECORD_AUDIO)
                }
                OnboardStep.RECORDING -> { // 시안 C07: 보조 440 + 큰 단추(나머지), 간격 24
                    CarButton("다시 녹음", Modifier.width(440.dp), CarButtonKind.Secondary, enabled = !o.busy) { o.again() }
                    CarButton("녹음 완료", Modifier.weight(1f), enabled = !o.busy && o.heard >= MIN_VOICE_SECONDS) { o.submitVoice() }
                }
                OnboardStep.DONE -> CarButton("가족 그룹 만들기") { o.done(); onFamily() }
            }
        },
    ) {
        val (title, sub) = when (step) {
            OnboardStep.WELCOME -> "함께 탄 순간을 오래" to "운전할 때는 부탁을, 여행 후에는 추억을."
            OnboardStep.SIGNUP -> "내 계정 만들기" to "이 계정으로 차량과 폰을 함께 사용해요."
            OnboardStep.LOGIN -> "로그인" to "가입한 이메일로 로그인해 기록을 불러와요."
            OnboardStep.CONSENT -> "우리의 대화를 남기기 전에" to "아래 내용을 확인하고 한 번에 동의해 주세요."
            OnboardStep.PROFILE -> "나를 소개해 주세요" to "01 프로필   →   02 목소리   →   03 가족"
            OnboardStep.PHOTO -> "프로필 사진" to "사진 대신 캐릭터도 언제든 선택할 수 있어요."
            OnboardStep.VOICE -> "15초만 들려주세요" to "02 목소리 등록 / 조용한 곳에서 혼자 읽어 주세요."
            OnboardStep.RECORDING -> "목소리를 듣고 있어요" to "주변 사람은 잠시 조용히 기다려 주세요."
            OnboardStep.DONE -> "${shownName}님의 목소리 등록 완료" to "차량과 폰에서 같은 프로필을 사용해요."
        }
        TitleBlock(title, sub)
        if (step == OnboardStep.WELCOME) {
            // 시안 C01 본문: 가운데 정렬, '두 순간'(680, 간격 40) · 간격 80 · 보관 카드
            Row(Modifier.weight(1f).fillMaxWidth(), Arrangement.spacedBy(80.dp, Alignment.CenterHorizontally), Alignment.CenterVertically) {
                Column(Modifier.width(680.dp), verticalArrangement = Arrangement.spacedBy(40.dp)) {
                    Moment("주행 중", "부탁은 놓치지 않도록", "도착할 때 필요한 내용을 모아드려요.")
                    Moment("주행 후", "즐거운 이야기는 오래도록", "목소리와 캐릭터로 남기는 우리 가족의 순간.")
                }
                ArchivePreview()
            }
        } else Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
            // 시안 C02–C08 본문: 가운데 988 폭, 위에서부터, 간격 24. 작은 창·오류 글로 넘치면 이 칸만 스크롤한다.
            Column(Modifier.widthIn(max = 988.dp).fillMaxWidth().fillMaxHeight().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(24.dp)) {
                when (step) {
                    OnboardStep.WELCOME -> Unit
                    OnboardStep.SIGNUP, OnboardStep.LOGIN -> {
                        // 로그인은 시안에 없어 C02 틀·조각 그대로(제목·칸·아래 카드만 다름). 가입 화면도 이미 가입한 이메일이면 로그인으로 잇는다(AccountApi.enter)
                        NoAutofill()
                        CarField("이메일", o.email, { o.email = it }, KeyboardType.Email, placeholder = "minjun@example.com")
                        CarField("비밀번호", o.password, { o.password = it }, KeyboardType.Password, secret = true, onDone = { o.submitAccount(login = step == OnboardStep.LOGIN) })
                        if (step == OnboardStep.SIGNUP) InfoCard("이미 계정이 있나요?", "같은 계정으로 로그인해 기록을 불러와요.", onClick = { o.go(OnboardStep.LOGIN) })
                        else InfoCard("처음이에요?", "계정 만들기", onClick = { o.go(OnboardStep.SIGNUP) })
                    }
                    OnboardStep.CONSENT -> {
                        InfoCard("탑승 시 대화 자동 기록", "가족 그룹 연결 시 시작 / 기록 상태 표시와 일시정지 제공")
                        InfoCard("서버 전송과 콘텐츠 생성", "음성과 전사록 업로드, 요약과 편집에 사용")
                        InfoCard("목소리 등록과 발화자 식별", "등록한 음성 특징으로 말하는 사람 구분")
                        Text("함께 타는 성인은 직접 동의하고, 아이의 프로필과 녹음은 보호자가 관리해요.", style = CarText.Label, color = c.onSurfaceVariant)
                    }
                    OnboardStep.PROFILE -> {
                        CarField("이름 또는 별명", o.name, { o.name = it.take(20) }, KeyboardType.Text, placeholder = "민준")
                        Text("내 캐릭터", style = CarText.Label, color = c.onSurfaceVariant)
                        // 시안 '캐릭터 선택': surface, 모서리 32, 여백 24, 캐릭터 넷(안경·힐링·캡모자·기본) 140(모서리 48) 간격 30. 고른 상태 그림은 시안에 없다.
                        Surface(Modifier.fillMaxWidth(), CarShape.Card, color = c.surface) {
                            Row(Modifier.padding(24.dp), horizontalArrangement = Arrangement.spacedBy(30.dp)) {
                                CHARS.take(4).forEach { (key, res) ->
                                    Box(Modifier.clip(CarShape.Face).clickable { o.character = key }) { CharAvatar(res, 140.dp, CarShape.Face, ring = o.character == key) } // 고른 캐릭터에 테(오너 11/15: 눌러도 고른 표시가 없어 선택이 안 되는 것처럼 보임)
                                }
                            }
                        }
                        CarButton("내 사진으로 바꾸기", kind = CarButtonKind.Secondary) { o.go(OnboardStep.PHOTO) }
                        Text("캐릭터와 이름은 같은 계정의 차량과 폰에 함께 저장돼요.", style = CarText.Label, color = c.onSurfaceVariant)
                    }
                    OnboardStep.PHOTO -> {
                        val b = o.photo
                        if (b != null) Image(b.asImageBitmap(), "고른 프로필 사진", Modifier.size(280.dp).clip(CarShape.Face), contentScale = ContentScale.Crop)
                        else CharAvatar(charDrawable(o.character), 280.dp, CarShape.Face)
                        InfoCard("내 사진 선택", "촬영 또는 사진 보관함에서 가져오기", onClick = {
                            // 기기 사진 보관함(사진 선택기)이 있을 때만. 없으면 '사진 대신 캐릭터'로 계속한다.
                            try { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) } catch (_: ActivityNotFoundException) { o.noGallery() }
                        })
                        Text("공유 콘텐츠에는 캐릭터를 기본으로 사용해요.", style = CarText.Body, color = c.onSurfaceVariant)
                    }
                    OnboardStep.VOICE, OnboardStep.RECORDING -> {
                        val rec = step == OnboardStep.RECORDING
                        if (rec) InfoCard("“함께 타는 순간을 오래 기억하고 싶어.”", "평소 말하는 목소리로 이어 읽어 주세요.", soft = true)
                        else InfoCard("“안녕, 나는 ${callName(shownName.ifBlank { "나" })}.", "우리 가족과 함께 여행하는 시간이 좋아. 오늘은 바다를 보러 가고, 맛있는 것도 먹을 거야.”", soft = true)
                        VoiceTimeline(rec, o.heard, o.levels)
                        if (!rec) Text("등록한 목소리로 차량에서 발화자를 구분해요.", style = CarText.Label, color = c.onSurfaceVariant)
                    }
                    OnboardStep.DONE -> {
                        InfoCard(shownName, "캐릭터와 음성 특징 저장 완료", soft = true, face = charDrawable(o.character), photo = o.photo) // 시안 '민준 / 아빠': 호칭 값이 없어 이름만
                        InfoCard("다음은 우리 가족", "아이의 프로필도 ${shownName}님이 만들어 줄 수 있어요.")
                    }
                }
            }
        }
    }
}

/** 시안 C01 '기억을 이어주는 두 순간'의 한 묶음: Label 24(ink-2) · Title 40 · Body 28(ink-2), 간격 12. */
@Composable
private fun Moment(label: String, title: String, detail: String) = Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
    val c = MaterialTheme.colorScheme
    Text(label, style = CarText.Label, color = c.onSurfaceVariant)
    Text(title, style = CarText.Title)
    Text(detail, style = CarText.Body, color = c.onSurfaceVariant)
}

/**
 * 시안 C01의 보관 카드 예시('Archive / galleryCar / 1', 400 × 550, 밝은 종이 tint-2, 모서리 25, 여백 30, 간격 20): 날짜·여행 18.75, 한마디 40/55,
 * 목소리의 주인공 둘(140 동그라미, 간격 15), 설명 16.25 Regular, 가치타 · 길이 18.75. 처음 화면의 고정 그림(실제 기록이 아님)이라 글은 시안 그대로다.
 * 콘텐츠 기록(F6, C33)의 갤러리 카드와 같은 조각이라, 그쪽이 CarDesign.kt로 올라가면 그것으로 바꾼다.
 */
@Composable
private fun ArchivePreview() {
    val small = CarText.Label.copy(fontSize = 18.75.sp, lineHeight = 27.5.sp)
    Surface(Modifier.size(400.dp, 550.dp), RoundedCornerShape(25.dp), color = CarPaper.Tints[1], contentColor = CarPaper.Ink) {
        Column(Modifier.padding(30.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Text("11.14  강릉 가족 여행", style = small, color = CarPaper.Ink2)
            Text("아빠, 아까부터\n바다 보이는데?", style = CarText.Title.copy(lineHeight = 55.sp), color = CarPaper.Ink)
            Spacer(Modifier.weight(1f))
            Row(Modifier.fillMaxWidth(), Arrangement.spacedBy(15.dp, Alignment.CenterHorizontally)) {
                CharAvatar(R.drawable.char_glasses, 140.dp, CircleShape) // 아빠
                CharAvatar(R.drawable.char_cap, 140.dp, CircleShape) // 서준
            }
            Text("서준의 한마디에 모두 웃음", Modifier.fillMaxWidth(), style = CarText.Label.copy(fontSize = 16.25.sp, lineHeight = 22.5.sp, fontWeight = FontWeight.Normal),
                color = CarPaper.Ink2, textAlign = TextAlign.Center)
            Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween) {
                Text("가치타", style = small, color = CarPaper.Ink2)
                Text("▶ 0:32", style = small, color = CarPaper.Ink)
            }
        }
    }
}

/**
 * 시안 C06·C07 '음성 타임라인'(surface, 모서리 32, 여백 28, 간격 24): 상태 글, 파형(높이 126, 막대 64개 간격 7, 모서리 3), 시간 범위.
 * 녹음 전은 시안 모양(모두 accent). 녹음 중·뒤는 지난 칸·지금 칸이 실제 소리 크기(VoiceMeter), 앞으로 칸은 시안 높이의 line 막대.
 */
@Composable
private fun VoiceTimeline(rec: Boolean, heard: Double, levels: DoubleArray) {
    val c = MaterialTheme.colorScheme
    val s = minOf(heard, VOICE_SECONDS.toDouble())
    Surface(Modifier.fillMaxWidth(), CarShape.Card, color = c.surface) {
        Column(Modifier.padding(28.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            Text(if (!rec) "목소리 등록 준비" else "녹음 중  ${s.toInt()} / ${VOICE_SECONDS}초", style = CarText.Label, color = c.onSurfaceVariant)
            val now = if (rec) minOf(BARS.size, (s / VOICE_SECONDS * BARS.size).toInt()) else BARS.size
            Row(Modifier.fillMaxWidth().height(126.dp), Arrangement.spacedBy(7.dp), Alignment.CenterVertically) {
                BARS.forEachIndexed { i, h ->
                    val on = !rec || i <= now
                    val height = if (rec && on) BAR_MIN + (BAR_MAX - BAR_MIN) * (levels.getOrNull(i) ?: 0.0).toFloat() else h
                    Box(Modifier.weight(1f).height(height.dp).clip(RoundedCornerShape(3.dp)).background(if (on) c.primary else c.outlineVariant))
                }
            }
            Row(Modifier.fillMaxWidth(), Arrangement.SpaceBetween) {
                Text(if (rec) "00:%02d".format(s.toInt()) else "00:00", style = CarText.Label, color = c.onSurfaceVariant)
                Text("00:%02d".format(VOICE_SECONDS), style = CarText.Label, color = c.onSurfaceVariant)
            }
        }
    }
}

// 가입·로그인 칸을 자동 완성에서 뺀다: 기기에 저장된 실제 이메일·비밀번호가 채워져 시연 영상에 보이지 않게.
// 이 화면이 떠 있는 동안만 앱 화면 전체(Compose 뷰와 그 안의 칸)를 자동 완성 대상에서 빼고, 닫히면 되돌린다.
@Composable
private fun NoAutofill() {
    val view = LocalView.current
    DisposableEffect(view) {
        val before = view.importantForAutofill
        view.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        onDispose { view.importantForAutofill = before }
    }
}
