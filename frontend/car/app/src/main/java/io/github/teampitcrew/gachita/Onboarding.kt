package io.github.teampitcrew.gachita

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
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/*
 * 차 계정·온보딩(T142, 최종 시안 C01–C08, 피그마 2004:57). 주차 중 전체 창(1682 × 1210)에만 보인다(주행 제한이면 MainActivity가 잠금 화면).
 * 시작 → 계정 만들기·로그인(이 차의 프로필 토큰) → 기록 동의 → 이름·캐릭터 → 사진 → 15초 목소리 → 등록 완료.
 * 목소리는 차 마이크로 15초를 모아 Voice.kt의 embed(pcmSamples(...))로 값(112차원)을 만들고 값만 올린다(ADR-0023). 소리는 차를 떠나지 않는다.
 * 계정 동의가 켜져 있지 않으면 마이크를 열지 않는다.
 * 계정 토큰이 있거나 '나중에'를 누르면 지금의 여행 만들기(Setup)로 간다. 디버그 실행 인자 --ez onboarding false로 건너뛴다(기존 e2e 스크립트).
 */

const val VOICE_SECONDS = 15
const val MIN_VOICE_SECONDS = 5 // '녹음 완료'가 눌리는 최소 길이. 서버는 1~20초를 받는다
private val BARS = listOf(40, 70, 96, 54, 84, 100, 44, 74, 92, 60, 88, 36, 80, 98, 66, 46, 84, 100, 70, 90, 50, 86, 98, 58, 76, 94, 42, 66, 88, 52, 92, 100, 62, 80, 44, 70, 96, 56, 82, 100, 48, 74, 90, 60, 86, 38, 72, 94, 58, 84, 98, 46, 78, 92, 54, 88, 66)
// 시안 C04의 캐릭터 순서(안경·힐링·캡모자·기본)와 나머지. 값은 서버 character(웹과 같은 이름).
private val CHARS = listOf("glasses" to R.drawable.char_glasses, "healing" to R.drawable.char_healing, "cap" to R.drawable.char_cap, "basic" to R.drawable.char_basic,
    "travel" to R.drawable.char_travel, "game" to R.drawable.char_game, "sport" to R.drawable.char_sport, "pet" to R.drawable.char_pet, "camping" to R.drawable.char_camping, "office" to R.drawable.char_office)

/** 시안의 프로필 캐릭터 칸 모서리(Character / 원본, 48). 92 칸에서는 동그라미, 110·140·280 칸에서는 둥근 네모. */
private val FACE = RoundedCornerShape(48.dp)

fun charDrawable(key: String): Int = CHARS.firstOrNull { it.first == key.removeSuffix("-small") }?.second ?: R.drawable.char_basic

class Onboarding(private val context: Context, private val prefs: SharedPreferences, private val server: () -> String) {
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val seal get() = Live.seal(context)

    var step by mutableStateOf<OnboardStep?>(null); private set
    var login by mutableStateOf(false); private set
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
    var recordDone by mutableStateOf(false); private set
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
    fun reopen() { skipped = false; finished = false; prefs.edit().putBoolean("onboardingSkipped", false).putBoolean("onboardingDone", false).apply(); step = null; start() }

    /** '나중에': 지금의 여행 만들기로. 이 차에 기억한다. */
    fun later() { stopRecording(); skipped = true; prefs.edit().putBoolean("onboardingSkipped", true).apply() }

    /** 디버그 실행 인자 --ez onboarding false(기존 e2e 스크립트가 처음 화면을 여행 만들기로 본다). */
    fun skipForDebug() { skipped = true; prefs.edit().putBoolean("onboardingSkipped", true).apply() }

    private fun finish() { stopRecording(); finished = true; prefs.edit().putBoolean("onboardingDone", true).apply() }

    /** 단계를 정한다. 토큰이 있으면 서버에서 프로필을 읽어 빠진 단계부터. */
    fun start() {
        if (step != null) return
        val t = token ?: run { step = OnboardStep.WELCOME; return }
        step = OnboardStep.WELCOME
        work({ AccountApi(server()).me(t) }) { p -> adopt(p); step = firstOnboardStep(p, true) }
    }

    fun go(next: OnboardStep) { note = ""; step = next }
    fun toggleLogin() { login = !login; note = "" }

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

    /** C02: 가입 또는 로그인. */
    fun submitAccount() {
        if (!validEmail(email)) { note = "이메일 주소를 확인해 주세요"; return }
        if (!validPassword(password)) { note = "비밀번호는 8~72자로 적어 주세요"; return }
        val e = email.trim(); val pw = password; val isLogin = login; val url = server()
        if (busy) return
        busy = true; note = ""
        io.execute {
            val r = runCatching { AccountApi(url).let { if (isLogin) it.login(e, pw) else it.signup(e, pw) } }
            main.post {
                busy = false
                r.onSuccess { (p, t) ->
                    saveToken(t); password = ""; adopt(p)
                    nextAfterAccount(p, isLogin)?.let(::go) ?: finish()
                }.onFailure {
                    note = accountError(it, isLogin)
                    if (it is ApiError && it.status == 409) login = true
                }
            }
        }
    }

    /** C03: 계정 동의. */
    fun agree() { val t = token ?: return go(OnboardStep.SIGNUP); work({ AccountApi(server()).consent(t) }) { adopt(it); go(OnboardStep.PROFILE) } }

    /** C04·C05: 이름·캐릭터(와 고른 사진)를 저장하고 목소리로. */
    fun saveProfile() {
        val t = token ?: return go(OnboardStep.SIGNUP)
        val n = name.trim().ifEmpty { note = "함께 타는 사람들에게 보일 이름을 적어 주세요"; return }.take(20)
        val c = character; val jpeg = photoJpeg; val url = server()
        work({ AccountApi(url).let { api -> jpeg?.let { api.photo(t, it) }; api.profile(t, n, c) } }) { adopt(it); photoJpeg = null; go(OnboardStep.VOICE) }
    }

    /** C05: 기기 사진 보관함에서 고른 사진. 640px JPEG로 다시 그린다(위치 같은 덧붙은 정보가 빠짐). */
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
            main.post { r.onSuccess { (b, jpeg) -> photo = b; photoJpeg = jpeg; note = "" }.onFailure { note = "이 사진은 읽지 못했어요. 다른 사진을 골라 주세요" } }
        }
    }

    fun noGallery() { note = "이 차에는 사진 보관함이 없어요. 사진 대신 캐릭터로 계속해요" }

    /** C06 → C07: 15초 녹음. 계정 동의가 켜져 있을 때만 마이크를 연다. */
    fun startRecording() {
        if (profile?.consent != true) { note = "기록 동의를 먼저 받아요"; step = OnboardStep.CONSENT; return }
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) { note = "마이크 권한이 없어 녹음할 수 없어요"; return }
        stopRecording()
        pcm = null; heard = 0.0; levels = DoubleArray(0); recordDone = false; note = ""; submitWhenStopped = false
        val meter = VoiceMeter(BARS.size)
        val rec = VoiceRecorder({ s, level -> meter.add(s, level); val snap = meter.snapshot(); main.post { if (recorder != null) { heard = s; levels = snap } } }) { bytes, failed ->
            main.post {
                if (failed != null) { note = failed; step = OnboardStep.VOICE; recorder = null; return@post }
                pcm = bytes; heard = bytes.size / 2.0 / RATE; recordDone = true; recorder = null
                if (submitWhenStopped) { submitWhenStopped = false; submitVoice() }
            }
        }
        recorder = rec
        step = OnboardStep.RECORDING
        rec.start()
    }

    fun stopRecording() { recorder?.cancel(); recorder = null }

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
            AccountApi(url).me(t)
        }) { p -> pcm = null; adopt(p); go(OnboardStep.DONE) }
    }

    /** C08 '가족 그룹 만들기'. */
    fun done() = finish()

    fun close() { stopRecording(); io.shutdown() }

}

// ---- 화면(시안 C 토큰: 카드 반경 32, 컨트롤 24, Title 40 / Headline 32 / Body 28 / Label 24) ----

@Composable
fun OnboardingScreen(o: Onboarding, gear: String?, onFamily: () -> Unit) {
    val c = MaterialTheme.colorScheme
    val ctx = LocalContext.current
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { o.picked(it) }
    val mic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { if (it) o.startRecording() }
    LaunchedEffect(o) { o.start() }
    val step = o.step ?: OnboardStep.WELCOME
    val p = o.profile
    val shownName = p?.name?.takeIf { it.isNotBlank() } ?: o.name
    Column(Modifier.fillMaxSize().background(c.background).padding(start = 40.dp, end = 40.dp, top = 40.dp, bottom = 40.dp)) {
        // 머리 줄: 마스코트 · 가치타 · 주차 중 P(시안). '나중에'는 시안에 없지만 지금의 여행 만들기로 가는 길이라 둔다.
        Row(Modifier.fillMaxWidth().height(80.dp), verticalAlignment = Alignment.CenterVertically) {
            Mascot(false, 48.dp)
            Spacer(Modifier.width(18.dp))
            Text("가치타", fontSize = 32.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            Text("주차 중  ${gear ?: "P"}", color = c.onSurfaceVariant, fontSize = 24.sp)
            Spacer(Modifier.width(40.dp))
            TextButton({ o.later() }, enabled = !o.busy) { Text("나중에", fontSize = 24.sp, color = c.onSurfaceVariant) }
        }
        Spacer(Modifier.height(24.dp))
        val (title, sub) = when (step) {
            OnboardStep.WELCOME -> "함께 탄 순간을 오래" to "운전할 때는 부탁을, 여행 후에는 추억을."
            OnboardStep.SIGNUP -> if (o.login) "내 계정으로 로그인" to "폰에서 만든 같은 계정으로 들어와요." else "내 계정 만들기" to "이 계정으로 차량과 폰을 함께 사용해요."
            OnboardStep.CONSENT -> "우리의 대화를 남기기 전에" to "아래 내용을 확인하고 한 번에 동의해 주세요."
            OnboardStep.PROFILE -> "나를 소개해 주세요" to "01 프로필   →   02 목소리   →   03 가족"
            OnboardStep.PHOTO -> "프로필 사진" to "사진 대신 캐릭터도 언제든 선택할 수 있어요."
            OnboardStep.VOICE -> "15초만 들려주세요" to "02 목소리 등록 / 조용한 곳에서 혼자 읽어 주세요."
            OnboardStep.RECORDING -> if (o.recordDone) "녹음을 마쳤어요" to "‘녹음 완료’를 누르면 등록해요." else "목소리를 듣고 있어요" to "주변 사람은 잠시 조용히 기다려 주세요."
            OnboardStep.DONE -> "${shownName}님의 목소리 등록 완료" to "차량과 폰에서 같은 프로필을 사용해요."
        }
        Text(title, fontSize = 40.sp, fontWeight = FontWeight.Bold, lineHeight = 50.sp)
        Spacer(Modifier.height(12.dp)) // 시안 화면 제목 묶음: Car/Title 40 lh50 · 간격 12 · Car/Label 24 lh32
        Text(sub, color = c.onSurfaceVariant, fontSize = 24.sp, lineHeight = 32.sp)
        Spacer(Modifier.height(24.dp))
        Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(24.dp)) {
                when (step) {
                    OnboardStep.WELCOME -> {
                        ObCard(soft = true, face = R.drawable.char_glasses, title = "우리 가족의 목소리로 남기는 여행", detail = "얼굴 대신 캐릭터, 우리 목소리 그대로")
                        ObCard(title = "차와 폰에서 이어지는 한 계정", detail = "가입부터 콘텐츠 보기까지 두 기기에서")
                    }
                    OnboardStep.SIGNUP -> {
                        NoAutofill()
                        Field("이메일", o.email, { o.email = it }, KeyboardType.Email, placeholder = "minjun@example.com")
                        Field("비밀번호", o.password, { o.password = it }, KeyboardType.Password, secret = true, placeholder = "8자 이상")
                        ObCard(title = if (o.login) "처음이신가요?" else "이미 계정이 있나요?", detail = if (o.login) "새 계정을 만들어 시작해요." else "같은 계정으로 로그인해 기록을 불러와요.", onClick = o::toggleLogin)
                    }
                    OnboardStep.CONSENT -> {
                        ObCard(title = "탑승 시 대화 자동 기록", detail = "가족 그룹 연결 시 시작 / 기록 상태 표시와 일시정지 제공")
                        ObCard(title = "서버 전송과 콘텐츠 생성", detail = "음성과 전사록 업로드, 요약과 편집에 사용")
                        ObCard(title = "목소리 등록과 발화자 식별", detail = "등록한 음성 특징으로 말하는 사람 구분")
                        Text("함께 타는 성인은 직접 동의하고, 아이의 프로필과 녹음은 보호자가 관리해요.", color = c.onSurfaceVariant, fontSize = 24.sp)
                        // ADR-0023 8절의 전환기 문장은 빼지 않는다(폰 동의 문구와 같은 뜻).
                        Text("여행을 마치고 주차하면 장면을 고를 수 있게 이 여행의 소리 전체가 서버로 올라가고, 다 올린 뒤 2일이 지나면 지워집니다. 콘텐츠는 고른 장면으로만 만들고, 소리 전체는 외부로 보내지 않습니다. 누가 말했는지는 차 안에서 가립니다. 이전 버전의 차량 앱과 웹 입력에서는 이를 위해 말소리가 잠시 서버로 갔다가 저장되지 않고 지워집니다. 등록한 목소리는 화자를 가리는 값으로만 바뀌어 서버에 저장되고, 동의를 끄면 지워집니다.",
                            color = c.onSurfaceVariant, fontSize = 20.sp, lineHeight = 28.sp)
                    }
                    OnboardStep.PROFILE -> {
                        Field("이름 또는 별명", o.name, { o.name = it.take(20) }, KeyboardType.Text, placeholder = "민준")
                        Text("내 캐릭터", color = c.onSurfaceVariant, fontSize = 24.sp)
                        Surface(Modifier.fillMaxWidth(), RoundedCornerShape(32.dp), color = c.surface) {
                            Row(Modifier.horizontalScroll(rememberScrollState()).padding(24.dp), horizontalArrangement = Arrangement.spacedBy(30.dp)) {
                                CHARS.forEach { (key, res) ->
                                    // 시안 C04: 캐릭터 140 칸을 크게 채움(모서리 48). 고른 캐릭터는 말하는 사람 고리와 같은 테두리
                                    Box(Modifier.clip(FACE).clickable { o.character = key }) { CharAvatar(res, 140.dp, FACE, ring = key == o.character) }
                                }
                            }
                        }
                        SecondaryButton("내 사진으로 바꾸기", Modifier.fillMaxWidth()) { o.go(OnboardStep.PHOTO) }
                        Text("캐릭터와 이름은 같은 계정의 차량과 폰에 함께 저장돼요.", color = c.onSurfaceVariant, fontSize = 24.sp)
                    }
                    OnboardStep.PHOTO -> {
                        val b = o.photo
                        if (b != null) Image(b.asImageBitmap(), "고른 프로필 사진", Modifier.size(280.dp).clip(FACE), contentScale = ContentScale.Crop)
                        else CharAvatar(charDrawable(o.character), 280.dp, FACE)
                        ObCard(title = "내 사진 선택", detail = "촬영 또는 사진 보관함에서 가져오기", onClick = {
                            // 기기 사진 보관함(사진 선택기)이 있을 때만. 없으면 '사진 대신 캐릭터'로 계속한다.
                            try { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) } catch (_: ActivityNotFoundException) { o.noGallery() }
                        })
                        Text("공유 콘텐츠에는 캐릭터를 기본으로 사용해요.", color = c.onSurfaceVariant, fontSize = 28.sp)
                    }
                    OnboardStep.VOICE, OnboardStep.RECORDING -> {
                        val rec = step == OnboardStep.RECORDING
                        val late = rec && o.heard >= 7
                        ObCard(soft = true, title = if (late) "“함께 타는 순간을 오래 기억하고 싶어.”" else "“안녕, 나는 ${callName(shownName.ifBlank { "나" })}.",
                            detail = if (late) "평소 말하는 목소리로 이어 읽어 주세요." else "우리 가족과 함께 여행하는 시간이 좋아. 오늘은 바다를 보러 가고, 맛있는 것도 먹을 거야.”")
                        Surface(Modifier.fillMaxWidth(), RoundedCornerShape(32.dp), color = c.surface) {
                            Column(Modifier.padding(start = 28.dp, end = 28.dp, top = 28.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                                val s = minOf(o.heard, VOICE_SECONDS.toDouble())
                                Text(if (!rec) "목소리 등록 준비" else "${if (o.recordDone) "녹음 끝" else "녹음 중"}  ${s.toInt()} / ${VOICE_SECONDS}초", color = c.onSurfaceVariant, fontSize = 24.sp)
                                // 녹음 전은 시안 모양(모두 켬). 녹음 중·뒤는 지난 칸·지금 칸이 실제 소리 크기, 앞으로 칸은 시안의 옅은 막대.
                                val now = if (rec) minOf(BARS.size, (s / VOICE_SECONDS * BARS.size).toInt()) else BARS.size
                                val lv = o.levels
                                Row(Modifier.fillMaxWidth().height(104.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                    BARS.forEachIndexed { i, h ->
                                        val on = !rec || i <= now
                                        val height = if (!rec) h else if (on) (12 + 88 * (lv.getOrNull(i) ?: 0.0)).toInt() else h
                                        Box(Modifier.width(6.dp).height(height.dp).clip(RoundedCornerShape(3.dp)).background(if (on) c.primary else c.surfaceVariant))
                                    }
                                }
                                Row(horizontalArrangement = Arrangement.spacedBy(160.dp)) {
                                    Text(if (rec) "00:%02d".format(s.toInt()) else "00:00", color = c.onSurfaceVariant, fontSize = 24.sp)
                                    Text("00:%02d".format(VOICE_SECONDS), color = c.onSurfaceVariant, fontSize = 24.sp)
                                }
                            }
                        }
                        if (!rec) Text("등록한 목소리로 차량에서 발화자를 구분해요. 소리는 이 차에서 값으로 바뀌고, 값만 서버에 저장돼요.", color = c.onSurfaceVariant, fontSize = 24.sp)
                    }
                    OnboardStep.DONE -> {
                        ObCard(soft = true, face = charDrawable(o.character), photo = o.photo, title = shownName, detail = if (p?.hasVoice == true) "캐릭터와 음성 특징 저장 완료" else "캐릭터 저장 완료")
                        ObCard(title = "다음은 우리 가족", detail = "아이의 프로필도 ${shownName}님이 만들어 줄 수 있어요.")
                    }
                }
                if (o.note.isNotEmpty()) Text(o.note, color = c.error, fontSize = 24.sp)
            }
            FamilyPanel(Modifier.width(590.dp).fillMaxHeight())
        }
        Spacer(Modifier.height(24.dp))
        when (step) {
            OnboardStep.WELCOME -> PrimaryButton("가치타 시작하기") { o.go(OnboardStep.SIGNUP) }
            OnboardStep.SIGNUP -> PrimaryButton(if (o.busy) "확인 중" else if (o.login) "로그인하고 계속" else "가입하고 계속", !o.busy) { o.submitAccount() }
            OnboardStep.CONSENT -> PrimaryButton(if (o.busy) "저장 중" else "동의하고 계속", !o.busy) { o.agree() }
            OnboardStep.PROFILE -> PrimaryButton(if (o.busy) "저장 중" else "목소리 등록하기", !o.busy) { o.saveProfile() }
            OnboardStep.PHOTO -> PrimaryButton(if (o.busy) "저장 중" else if (o.photo != null) "사진으로 계속" else "캐릭터로 계속", !o.busy) { o.saveProfile() }
            OnboardStep.VOICE -> PrimaryButton("녹음 시작", !o.busy) {
                if (ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) o.startRecording() else mic.launch(Manifest.permission.RECORD_AUDIO)
            }
            OnboardStep.RECORDING -> Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                SecondaryButton("다시 녹음", Modifier.width(440.dp), enabled = !o.busy) { o.startRecording() }
                PrimaryButton(if (o.busy) "등록 중" else "녹음 완료", !o.busy && o.heard >= MIN_VOICE_SECONDS, Modifier.weight(1f)) { o.submitVoice() }
            }
            OnboardStep.DONE -> PrimaryButton("가족 그룹 만들기") { o.done(); onFamily() }
        }
    }
}

@Composable
private fun ObCard(title: String, detail: String, soft: Boolean = false, face: Int? = null, photo: Bitmap? = null, onClick: (() -> Unit)? = null) {
    val c = MaterialTheme.colorScheme
    Surface(Modifier.fillMaxWidth().then(if (onClick != null) Modifier.clip(RoundedCornerShape(32.dp)).clickable(onClick = onClick) else Modifier), RoundedCornerShape(32.dp),
        color = if (soft) c.primaryContainer else c.surface, contentColor = c.onSurface) {
        Row(Modifier.padding(26.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(24.dp)) { // 시안 카드: 여백 26 · 간격 24
            if (photo != null) Image(photo.asImageBitmap(), null, Modifier.size(92.dp).clip(CircleShape), contentScale = ContentScale.Crop)
            else if (face != null) CharAvatar(face, 92.dp)
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(title, fontSize = 32.sp, fontWeight = FontWeight.Bold, lineHeight = 42.sp)
                Text(detail, color = c.onSurfaceVariant, fontSize = 24.sp, lineHeight = 32.sp)
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

@Composable
private fun Field(label: String, value: String, change: (String) -> Unit, type: KeyboardType, secret: Boolean = false, placeholder: String = "") {
    val c = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(label, color = c.onSurfaceVariant, fontSize = 24.sp)
        BasicTextField(value, change, Modifier.fillMaxWidth().height(84.dp), singleLine = true,
            textStyle = TextStyle(color = c.onSurface, fontSize = 28.sp), cursorBrush = SolidColor(c.primary),
            keyboardOptions = KeyboardOptions(keyboardType = type), visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
            decorationBox = { inner ->
                Box(Modifier.fillMaxSize().clip(RoundedCornerShape(42.dp)).background(c.surfaceVariant).padding(horizontal = 24.dp), contentAlignment = Alignment.CenterStart) {
                    if (value.isEmpty()) Text(placeholder, color = c.onSurfaceVariant.copy(alpha = 0.6f), fontSize = 28.sp)
                    inner()
                }
            })
    }
}

@Composable
private fun PrimaryButton(label: String, enabled: Boolean = true, modifier: Modifier = Modifier.fillMaxWidth(), onClick: () -> Unit) =
    Button(onClick, modifier.height(96.dp), enabled = enabled, shape = RoundedCornerShape(24.dp)) { Text(label, fontSize = 32.sp, fontWeight = FontWeight.Bold) }

@Composable
private fun SecondaryButton(label: String, modifier: Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    val c = MaterialTheme.colorScheme
    Button(onClick, modifier.height(96.dp), enabled = enabled, shape = RoundedCornerShape(24.dp),
        colors = ButtonDefaults.buttonColors(containerColor = c.surfaceVariant, contentColor = c.onSurface)) { Text(label, fontSize = 30.sp, fontWeight = FontWeight.Bold) }
}

/**
 * 오른쪽 '차가 바뀌어도 우리는 그대로 · 우리 가족 4명'(시안 C01–C08 공통).
 * mock: 가족 그룹 API(F2, T133 #372)가 병합되기 전이라 캐릭터 넷과 '4명'을 고정으로 보인다. 그룹이 들어오면 GET /groups의 구성원으로 바꾼다.
 */
@Composable
private fun FamilyPanel(modifier: Modifier) {
    // mock: 그룹(F2) 전까지 고정한 가족 넷
    val c = MaterialTheme.colorScheme
    Surface(modifier, RoundedCornerShape(32.dp), color = c.surface) {
        Column(Modifier.padding(32.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("차가 바뀌어도\n우리는 그대로", fontSize = 40.sp, fontWeight = FontWeight.Bold, lineHeight = 52.sp)
            Text("한 번 만든 가족 프로필로\n차량과 폰에서 이어가세요.", color = c.onSurfaceVariant, fontSize = 28.sp, lineHeight = 40.sp)
            Spacer(Modifier.height(4.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                listOf(R.drawable.char_glasses, R.drawable.char_healing, R.drawable.char_cap, R.drawable.char_basic).forEach { res ->
                    CharAvatar(res, 110.dp, FACE)
                }
            }
            Spacer(Modifier.height(8.dp))
            Text("우리 가족  4명", fontSize = 32.sp, fontWeight = FontWeight.Bold)
            Text("프로필과 목소리, 가족 그룹을\n같은 계정으로 함께 사용", color = c.onSurfaceVariant, fontSize = 24.sp, lineHeight = 32.sp)
        }
    }
}
