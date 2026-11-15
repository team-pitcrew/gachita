package io.github.teampitcrew.gachita

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

// 차에서 하는 계정·온보딩(T142)의 서버 호출과 단계 규칙. 계약: docs/api/accounts.md(T128 #366), 프로필 목소리 값(T125 #356, ADR-0023).
// 차는 이메일 로그인으로 이 차의 프로필 토큰을 받고(POST /api/sessions, 기기 '차'), 그 토큰으로 동의·이름·사진·목소리 값을 올린다.
// Server.kt의 여행 경로와 섞지 않으려고 따로 둔다(Server.voice·voicePrints는 그대로).

/** 본인에게만 오는 프로필 모양(GET /api/profiles/me). */
data class AccountProfile(
    val id: String, val name: String, val character: String, val email: String?,
    val consent: Boolean, val hasVoice: Boolean, val hasPhoto: Boolean,
    val consentVersion: String? = null,
)

/** 차 C03이 보여 주는 동의 문구의 판. 서버 backend/api/accounts.js CONSENT_VERSION과 같게 둔다(문구를 바꾸면 둘 다). */
const val CONSENT_VERSION = "2026-11-14"

fun parseAccountProfile(json: String): AccountProfile = JSONObject(json).let { o ->
    AccountProfile(
        id = o.getString("id"), name = o.optString("name"), character = o.optString("character"),
        email = o.optString("email").takeIf { !o.isNull("email") && it.isNotEmpty() },
        consent = o.optBoolean("consent"), hasVoice = o.optBoolean("hasVoice"), hasPhoto = o.optBoolean("hasPhoto"),
        consentVersion = o.optString("consentVersion").takeIf { !o.isNull("consentVersion") && it.isNotEmpty() },
    )
}

/** 시안 C01–C08의 단계. RECORDING은 C07(녹음 중·녹음 끝). */
enum class OnboardStep { WELCOME, SIGNUP, CONSENT, PROFILE, PHOTO, VOICE, RECORDING, DONE }

/**
 * 가입·로그인·다시 열기 뒤 빠진 단계만(11/15 오너: DB에 있는 계정으로 로그인하면 처음부터 다시 받지 않는다):
 * 지금 판의 동의가 없으면 C03, 이름(가입 때 넣은 이메일 앞부분은 이름이 아님)·캐릭터가 없으면 C04, 목소리(1차 값)가 없으면 C06,
 * 다 있으면 null(온보딩을 끝내고 가족·그룹 화면). 둘째 값(강한 화자 값)이 없는 옛 계정은 막지 않는다(차는 1차 값으로 대조, #543).
 */
fun missingStep(p: AccountProfile): OnboardStep? = when {
    !(p.consent && p.consentVersion == CONSENT_VERSION) -> OnboardStep.CONSENT
    p.name.isBlank() || p.email?.let { p.name == provisionalName(it) } == true || p.character.isBlank() -> OnboardStep.PROFILE
    !p.hasVoice -> OnboardStep.VOICE
    else -> null
}

/** 처음 열 때: 토큰이 없으면 시작, 있으면 빠진 단계(missingStep). null이면 이미 다 마친 계정. */
fun firstOnboardStep(p: AccountProfile?, hasToken: Boolean): OnboardStep? = if (!hasToken || p == null) OnboardStep.WELCOME else missingStep(p)

/** 읽을 문장의 이름 부르기: 받침이 있으면 '이야', 없으면 '야'(시안 '나는 민준이야'). */
fun callName(name: String): String {
    val n = name.trim()
    val code = (n.lastOrNull() ?: ' ').code - 0xAC00
    return n + if (code in 0 until 11172 && code % 28 == 0) "야" else "이야"
}

/** 서버가 가입 때 이름을 꼭 받는다. 이메일 앞부분을 임시 이름으로 보내고 C04에서 고친다. */
fun provisionalName(email: String): String = email.substringBefore('@').ifEmpty { "나" }.take(20)

private val EMAIL = Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")
fun validEmail(email: String) = EMAIL.matches(email.trim())
fun validPassword(password: String) = password.codePointCount(0, password.length) in 8..72

/** 서버 오류를 화면 문장으로. 로그인 실패(401)는 이메일과 비밀번호 중 무엇이 틀렸는지 말하지 않는다(서버와 같음). 가입한 이메일(409)은 enter가 로그인으로 잇는다. */
fun accountError(e: Throwable): String = when {
    e !is ApiError -> "연결이 끊겨서 보내지 못했어요"
    e.status == 401 -> "이메일 또는 비밀번호가 맞지 않아요"
    e.status == 400 && "password" in (e.message ?: "") -> "비밀번호는 8~72자로 적어 주세요"
    e.status == 400 && "email" in (e.message ?: "") -> "이메일 주소를 확인해 주세요"
    else -> failureText(e)
}

/** 계정·프로필 경로. 메인 스레드에서 부르지 않는다. 토큰은 머리말로만 보낸다. */
class AccountApi(base: String, private val open: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection }) {
    private val base = base.trim().trimEnd('/')

    /** 새 계정과 이 차의 토큰(201). */
    fun signup(email: String, password: String): Pair<AccountProfile, String> =
        withToken(call("POST", "/api/accounts", JSONObject().put("email", email.trim()).put("password", password).put("name", provisionalName(email.trim())).put("device", DEVICE))!!)

    /**
     * 시안 C02 '가입하고 계속': 새 이메일이면 가입하고, 이미 가입한 이메일(409)이면 같은 이메일·비밀번호로 로그인한다
     * (시안 카드 '이미 계정이 있나요? 같은 계정으로 로그인해 기록을 불러와요' — 폰에서 만든 계정을 차에서 이어 씀). 둘째 값은 원래 있던 계정인지.
     */
    fun enter(email: String, password: String): Pair<Pair<AccountProfile, String>, Boolean> =
        try { signup(email, password) to false } catch (e: ApiError) { if (e.status == 409) login(email, password) to true else throw e }

    /** 같은 계정으로 이 차에 들어오기(새 기기 토큰). */
    fun login(email: String, password: String): Pair<AccountProfile, String> =
        withToken(call("POST", "/api/sessions", JSONObject().put("email", email.trim()).put("password", password).put("device", DEVICE))!!)

    fun me(token: String): AccountProfile = parseAccountProfile(call("GET", "/api/profiles/me", null, token)!!)

    /** 계정 동의(C03). 판은 보내지 않아 서버의 지금 판으로 남는다. */
    fun consent(token: String): AccountProfile = parseAccountProfile(call("PATCH", "/api/profiles/me", JSONObject().put("consent", true), token)!!)

    fun profile(token: String, name: String, character: String): AccountProfile =
        parseAccountProfile(call("PATCH", "/api/profiles/me", JSONObject().put("name", name).put("character", character), token)!!)

    /** 프로필 사진(JPEG, 640px로 다시 그린 것). 서버는 형식을 매직 바이트로 본다. */
    fun photo(token: String, jpeg: ByteArray) { call("PUT", "/api/profiles/me/photo", jpeg, token, "image/jpeg") }

    /** 차 안에서 계산한 목소리 값만 올린다(ADR-0023). 소리는 보내지 않는다. */
    fun voice(token: String, vector: DoubleArray, seconds: Double) { call("POST", "/api/profiles/me/voice", voiceValue(vector, seconds), token) }

    /** 둘째 값(강한 화자 값, strongValue)을 같은 경로로 올린다. 1차 값을 올린 뒤에(서버가 1차 값이 없으면 409). */
    fun strongVoice(token: String, body: JSONObject) { call("POST", "/api/profiles/me/voice", body, token) }
    fun childStrongVoice(token: String, groupId: String, profileId: String, body: JSONObject) { call("POST", "/api/groups/$groupId/members/$profileId/voice", body, token) }

    /** 보호자가 아이의 목소리 값을 올린다(POST /groups/{id}/members/{profileId}/voice, 본문은 본인 등록과 같음). 보호자 동의가 꺼져 있으면 서버가 409. */
    fun childVoice(token: String, groupId: String, profileId: String, vector: DoubleArray, seconds: Double) {
        call("POST", "/api/groups/$groupId/members/$profileId/voice", voiceValue(vector, seconds), token)
    }

    private fun withToken(json: String) = parseAccountProfile(json) to JSONObject(json).getString("token")

    private fun call(method: String, path: String, body: Any?, token: String? = null, type: String = "application/json"): String? {
        val c = open(URL(base + path))
        try {
            c.requestMethod = method
            c.connectTimeout = 5000
            c.readTimeout = 10000
            c.instanceFollowRedirects = false
            token?.let { c.setRequestProperty("Authorization", "Bearer $it") }
            if (body != null) {
                val bytes = if (body is ByteArray) body else body.toString().toByteArray()
                c.doOutput = true
                c.setFixedLengthStreamingMode(bytes.size)
                c.setRequestProperty("Content-Type", type)
                c.outputStream.use { it.write(bytes) }
            }
            val code = c.responseCode
            if (code == 204) return null
            val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (code >= 400) throw ApiError(code, runCatching { JSONObject(text).getString("error") }.getOrNull() ?: text)
            return text
        } finally {
            c.disconnect()
        }
    }

    companion object { const val DEVICE = "차" }
}
