package io.github.teampitcrew.gachita

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** 같이타 API(docs/api/openapi.yaml)를 부른다. 메인 스레드에서 부르지 않는다. */
class Server(base: String) {
    private val base = base.trim().trimEnd('/')

    /** 여행 JSON(openapi.yaml의 Trip)을 그대로 돌려준다. 앱은 마지막 응답을 저장해 두었다 끊겼을 때 보여 준다. */
    fun createTrip(title: String): String = call("POST", "/api/trips", JSONObject().put("title", title))!!

    /** 손님으로 참가. 이름과 자리를 보내고 동의는 꺼짐으로 시작한다. */
    fun join(code: String, m: Member) {
        call("POST", "/api/trips/$code/participants", JSONObject().put("seat", m.seat.name).put("name", m.name).put("consent", false))
    }

    fun consent(code: String, id: String, on: Boolean) {
        call("PATCH", "/api/trips/$code/participants/$id", JSONObject().put("consent", on))
    }

    /** 최신 여행. 보낸 version에서 바뀐 것이 없으면(304) null. */
    fun trip(code: String, version: Int? = null): String? = call("GET", "/api/trips/$code" + (version?.let { "?v=$it" } ?: ""), null)

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
