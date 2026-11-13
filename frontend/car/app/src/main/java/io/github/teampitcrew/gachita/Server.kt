package io.github.teampitcrew.gachita

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** 가치타 API(docs/api/openapi.yaml)를 부른다. 메인 스레드에서 부르지 않는다. */
class Server(base: String) {
    private val base = base.trim().trimEnd('/')

    /** 받은 여행 원문과 해석한 값. 앱은 원문을 저장해 두었다 끊겼을 때 보여 준다. */
    data class Got(val json: String, val trip: Trip)

    /**
     * 해석도 여기서 한다(통신 스레드). 200인데 여행 JSON이 아니면(공용 와이파이의 로그인 화면 등) JSONException이 나고,
     * 부르는 쪽은 ApiError가 아니므로 '연결 문제'로 다룬다.
     */
    private fun got(json: String) = Got(json, parseTrip(json))

    fun createTrip(title: String): Got = got(call("POST", "/api/trips", JSONObject().put("title", title))!!)

    /** 손님으로 참가. 이름과 자리를 보내고 동의는 꺼짐으로 시작한다. */
    fun join(code: String, m: Member) {
        call("POST", "/api/trips/$code/participants", JSONObject().put("seat", m.seat.name).put("name", m.name).put("consent", false))
    }

    fun consent(code: String, id: String, on: Boolean) {
        call("PATCH", "/api/trips/$code/participants/$id", JSONObject().put("consent", on))
    }

    /** 부탁 남기기(T9). 새 부탁의 id. 처음 상태는 held. */
    fun request(code: String, by: String, text: String): String =
        JSONObject(call("POST", "/api/trips/$code/requests", JSONObject().put("by", by).put("text", text.take(200)).put("when", "now"))!!).getString("id")

    /** 부탁 상태 바꾸기. 갈 수 없는 길이면(그사이 폰에서 취소됨 등) 409 ApiError. */
    fun requestStatus(code: String, id: String, status: String) {
        call("PATCH", "/api/trips/$code/requests/$id", JSONObject().put("status", status))
    }

    /** 최신 여행. 보낸 version에서 바뀐 것이 없으면(304) null. */
    fun trip(code: String, version: Int? = null): Got? = call("GET", "/api/trips/$code" + (version?.let { "?v=$it" } ?: ""), null)?.let(::got)

    private fun call(method: String, path: String, body: JSONObject?): String? {
        val c = URL(base + path).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method // 안드로이드의 HttpURLConnection은 PATCH를 받는다
            c.connectTimeout = 5000
            c.readTimeout = 5000
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val code = c.responseCode
            if (code == 304) return null
            val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (code >= 400) throw ApiError(code, runCatching { JSONObject(text).getString("error") }.getOrDefault(text))
            return text
        } finally {
            c.disconnect()
        }
    }
}

/** 서버가 거절함(4xx·5xx). 통신 자체가 안 된 것(IOException)과 구분해 '연결 끊김'으로 보지 않는다. */
class ApiError(val status: Int, message: String) : Exception("$status $message")
