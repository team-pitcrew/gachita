package io.github.teampitcrew.gachita

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread

/** 차 계정·온보딩(T142)의 단계 규칙과 계정 호출의 모양. 화면은 에뮬레이터 스크린샷(verification/20261115-F1)으로 본다. */
class OnboardingTest {
    private val base = AccountProfile("p1", "minjun", "", "minjun@example.com", consent = false, hasVoice = false, hasPhoto = false)

    @Test fun `처음 열 때 - 토큰 없음은 시작, 동의 전은 동의, 그 밖은 프로필부터`() {
        assertEquals(OnboardStep.WELCOME, firstOnboardStep(null, false))
        assertEquals(OnboardStep.CONSENT, firstOnboardStep(base, true))
        assertEquals(OnboardStep.PROFILE, firstOnboardStep(base.copy(consent = true), true))
        assertEquals(OnboardStep.PROFILE, firstOnboardStep(base.copy(consent = true, hasVoice = true), true))
    }

    @Test fun `계정 뒤 - 동의가 없으면 동의, 로그인했고 목소리까지 있으면 끝`() {
        assertEquals(OnboardStep.CONSENT, nextAfterAccount(base.copy(hasVoice = true), login = true))
        assertNull(nextAfterAccount(base.copy(consent = true, hasVoice = true), login = true))
        assertEquals(OnboardStep.PROFILE, nextAfterAccount(base.copy(consent = true), login = true))
        assertEquals(OnboardStep.PROFILE, nextAfterAccount(base.copy(consent = true, hasVoice = true), login = false))
    }

    @Test fun `읽을 문장의 조사와 임시 이름, 입력 검사`() {
        assertEquals("민준이야", callName("민준"))
        assertEquals("서아야", callName("서아"))
        assertEquals("minjun", provisionalName("minjun@example.com"))
        assertTrue(validEmail(" a@b.co "))
        assertFalse(validEmail("ab.co"))
        assertTrue(validPassword("12345678"))
        assertFalse(validPassword("1234567"))
    }

    @Test fun `서버 오류 문장 - 로그인 실패는 어느 칸인지 말하지 않음`() {
        assertEquals("이메일 또는 비밀번호가 맞지 않아요", accountError(ApiError(401, "이메일 또는 비밀번호가 맞지 않아요"), login = true))
        assertEquals("이미 가입한 이메일이에요. 로그인해 주세요", accountError(ApiError(409, "이미 가입한 이메일"), login = false))
        assertEquals("연결이 끊겨서 보내지 못했어요", accountError(java.io.IOException("x"), login = false))
    }

    @Test fun `프로필 모양 - 이메일 null과 목소리·동의`() {
        val p = parseAccountProfile("""{"id":"x","name":"민준","character":"glasses","email":null,"consent":true,"hasVoice":true,"hasPhoto":false}""")
        assertNull(p.email)
        assertTrue(p.consent && p.hasVoice)
        assertEquals(R.drawable.char_glasses, charDrawable("glasses-small"))
    }

    /** 요청 하나를 받아 머리·본문을 남기고 정해 둔 응답을 돌려주는 소켓 서버. */
    private fun serve(status: Int, body: String, test: (String, () -> Pair<String, String>) -> Unit) {
        val sock = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
        var head = ""; var sent = ""
        val t = thread(isDaemon = true) {
            sock.accept().use { c ->
                val r = c.getInputStream().bufferedReader()
                val lines = generateSequence { r.readLine()?.takeIf { it.isNotEmpty() } }.toList()
                head = lines.joinToString("\n")
                val len = lines.firstOrNull { it.startsWith("Content-Length:", true) }?.substringAfter(":")?.trim()?.toInt() ?: 0
                sent = String(CharArray(len).also { r.read(it) })
                val b = body.toByteArray()
                c.getOutputStream().apply {
                    write("HTTP/1.1 $status X\r\nContent-Type: application/json\r\nContent-Length: ${b.size}\r\nConnection: close\r\n\r\n".toByteArray()); write(b); flush()
                }
            }
        }
        try { test("http://127.0.0.1:${sock.localPort}/") { t.join(2000); head to sent } } finally { sock.close() }
    }

    @Test fun `가입은 이메일·비밀번호·임시 이름·기기 '차'를 보내고 프로필과 토큰을 받는다`() =
        serve(201, """{"id":"p1","name":"minjun","email":"minjun@example.com","consent":false,"hasVoice":false,"token":"tok"}""") { url, got ->
            val (p, token) = AccountApi(url).signup(" minjun@example.com", "pass-word-1")
            val (head, body) = got()
            assertTrue(head.startsWith("POST /api/accounts"))
            val o = JSONObject(body)
            assertEquals("minjun@example.com", o.getString("email"))
            assertEquals("minjun", o.getString("name"))
            assertEquals("차", o.getString("device"))
            assertEquals("tok", token)
            assertEquals("p1", p.id)
        }

    @Test fun `목소리는 값만 프로필 토큰으로 올린다`() = serve(200, """{"seconds":15,"dims":112}""") { url, got ->
        AccountApi(url).voice("tok-123", DoubleArray(VOICE_DIMS) { 0.0 }, 15.0)
        val (head, body) = got()
        assertTrue(head.startsWith("POST /api/profiles/me/voice"))
        assertTrue(head.lines().any { it.equals("Authorization: Bearer tok-123", true) })
        val o = JSONObject(body)
        assertEquals("logmel-pitch-1", o.getString("embedder"))
        assertEquals(VOICE_DIMS, o.getJSONArray("vector").length())
    }

    @Test fun `로그인 실패는 ApiError 401`() = serve(401, """{"error":"이메일 또는 비밀번호가 맞지 않아요"}""") { url, _ ->
        val e = runCatching { AccountApi(url).login("a@b.co", "12345678") }.exceptionOrNull()
        assertTrue(e is ApiError && e.status == 401)
    }
}
