package io.github.teampitcrew.gachita

import org.json.JSONArray
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

    /** 손님으로 참가. 이름과 자리를 보내고 동의는 꺼짐으로 시작한다. 참가자 id와 참가자 토큰(이때 한 번만 옴). */
    fun join(code: String, m: Member): Pair<String, String> =
        JSONObject(call("POST", "/api/trips/$code/participants", JSONObject().put("seat", m.seat.name).put("name", m.name).put("consent", false))!!)
            .let { it.getString("id") to it.getString("token") }

    /** 동의 켜기는 그 사람의 참가자 토큰으로만 된다(T68). 끄기는 토큰 없이 누구나. */
    fun consent(code: String, id: String, on: Boolean, token: String? = null) {
        call("PATCH", "/api/trips/$code/participants/$id", JSONObject().put("consent", on), token)
    }

    /** 발화 묶음 올리기(ADR-0014). 서버가 빠짐없이 받은 마지막 순번. 동의하지 않은 사람이 있으면 403 ApiError. */
    fun utterances(code: String, token: String, device: String, items: JSONArray): Long =
        JSONObject(call("POST", "/api/trips/$code/utterances", JSONObject().put("device", device).put("items", items), token)!!).getLong("lastSeq")

    /** 부탁 남기기(T9). 새 부탁의 id. 처음 상태는 held. */
    fun request(code: String, by: String, text: String): String =
        JSONObject(call("POST", "/api/trips/$code/requests", JSONObject().put("by", by).put("text", text.take(200)).put("when", "now"))!!).getString("id")

    /** 부탁 상태 바꾸기. 갈 수 없는 길이면(그사이 폰에서 취소됨 등) 409 ApiError. */
    fun requestStatus(code: String, id: String, status: String) {
        call("PATCH", "/api/trips/$code/requests/$id", JSONObject().put("status", status))
    }

    /** 최신 여행. 보낸 version에서 바뀐 것이 없으면(304) null. 서버가 여행을 모르면(없음, 48시간 지남) Gone. */
    fun trip(code: String, version: Int? = null): Got? = call("GET", "/api/trips/$code" + (version?.let { "?v=$it" } ?: ""), null)?.let(::got)

    /** 서버에 글이 남아 있는 이 기기 발화의 순번(GET /utterances?device=). 참가자가 지운 글(비운 줄)은 빠진다. */
    fun keptSeqs(code: String, token: String, device: String): Set<Long> =
        JSONObject(call("GET", "/api/trips/$code/utterances?device=" + java.net.URLEncoder.encode(device, "UTF-8"), null, token)!!).getJSONArray("items")
            .let { a -> (0 until a.length()).map { a.getJSONObject(it).getLong("seq") }.toSet() }

    /**
     * 확정한 장면의 원음 클립 올리기(T76, POST /recordings). wav는 16 kHz 모노, from은 첫 표본 시각(epoch ms), generation은 녹음할 때의 동의 세대.
     * 거절은 ApiError: 400·404·409·413은 버리고, 401·403·503은 나중에 다시(api-media 계약).
     */
    fun recording(code: String, token: String, moment: String, generation: Int, from: Long, wav: ByteArray) {
        call("POST", "/api/trips/$code/recordings?moment=$moment&generation=$generation&from=$from", wav, token)
    }

    private fun call(method: String, path: String, body: Any?, token: String? = null): String? {
        val c = URL(base + path).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method // 안드로이드의 HttpURLConnection은 PATCH를 받는다
            c.connectTimeout = 5000
            c.readTimeout = 5000
            token?.let { c.setRequestProperty("Authorization", "Bearer $it") } // 토큰은 머리말로만(주소에 넣지 않음, Pleos 보안 가이드)
            if (body != null) {
                c.doOutput = true
                val bytes = if (body is ByteArray) body.also { c.setFixedLengthStreamingMode(it.size) } else body.toString().toByteArray()
                c.setRequestProperty("Content-Type", if (body is ByteArray) "audio/wav" else "application/json")
                c.outputStream.use { it.write(bytes) }
            }
            val code = c.responseCode
            if (code == 304) return null
            val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
            val error = runCatching { JSONObject(text).getString("error") }.getOrNull()
            // 여행 경로에서 서버가 그 여행을 모른다고 할 때만 Gone(프록시의 404 쪽이나 '없는 참가자'로는 지우지 않음)
            if (code == 404 && error in TRIP_GONE && path.startsWith("/api/trips/")) throw Gone(path.split("/")[3])
            if (code >= 400) throw ApiError(code, error ?: text)
            return text
        } finally {
            c.disconnect()
        }
    }
}

/** 서버가 거절함(4xx·5xx). 통신 자체가 안 된 것(IOException)과 구분해 '연결 끊김'으로 보지 않는다. */
open class ApiError(val status: Int, message: String) : Exception("$status $message")

/** 서버(withTrip)가 여행을 모를 때의 404 문구. 이것만 여행이 없어진 것으로 본다. */
private val TRIP_GONE = setOf("없는 여행 코드", "보관 기간이 지난 여행")

/** 서버가 여행을 모른다(404: 없음, 보관 48시간 지남). 차 안 사본도 지운다(T69). */
class Gone(code: String) : ApiError(404, "없는 여행 $code")
