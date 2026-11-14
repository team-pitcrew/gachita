package io.github.teampitcrew.gachita

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.OutputStream
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

    fun seat(code: String, id: String, seat: Seat) {
        call("PATCH", "/api/trips/$code/participants/$id", JSONObject().put("seat", seat.name))
    }

    /** 발화 묶음 올리기(ADR-0014). 서버가 빠짐없이 받은 마지막 순번. 동의하지 않은 사람이 있으면 403 ApiError. */
    fun utterances(code: String, token: String, device: String, items: JSONArray): Long =
        JSONObject(call("POST", "/api/trips/$code/utterances", JSONObject().put("device", device).put("items", items), token)!!).getLong("lastSeq")

    /** 숏폼 구성(T43, #63 계약). 녹음에 동의한 참가자의 토큰으로. */
    fun transcript(code: String, token: String): String = call("GET", "/api/trips/$code/transcript", null, token)!!

    fun shortform(code: String, token: String): String = call("GET", "/api/trips/$code/shortform", null, token)!!

    fun shortTemplates(): JSONObject = JSONObject(call("GET", "/api/short-templates", null)!!)
    fun shortPlan(code: String, token: String, template: String, audio: Boolean): JSONObject = JSONObject(call("POST", "/api/trips/$code/short-plans", JSONObject().put("templateId", template).put("audioReference", audio), token)!!)
    fun shortJobs(code: String, token: String): JSONArray = JSONObject(call("GET", "/api/trips/$code/short-generations", null, token)!!).getJSONArray("items")
    fun shortJob(code: String, token: String, id: String): JSONObject = JSONObject(call("GET", "/api/trips/$code/short-generations/$id", null, token)!!)
    fun completedShortJob(code: String, token: String, id: String): JSONObject = shortJob(code, token, id).also { if (it.optString("state") != "completed") throw ApiError(409, "영상이 취소되었거나 아직 완성되지 않았어요") }
    fun createShortJob(code: String, token: String, body: JSONObject): JSONObject = JSONObject(call("POST", "/api/trips/$code/short-generations", body, token)!!)
    fun cancelShortJob(code: String, token: String, id: String) { call("DELETE", "/api/trips/$code/short-generations/$id", null, token) }

    /** 미리듣기·영상 만들기용 클립 받기. 주소는 shortClipAddress로 제한하고 요청이 연결·파일을 소유합니다. */
    fun downloadShort(url: String, token: String, file: File, cancelled: () -> Boolean, connection: (HttpURLConnection?) -> Unit,
        openOutput: () -> OutputStream = { file.outputStream() }, maxBytes: Long = 5_000_000L, mimeType: String? = null) {
        val c = URL(url).openConnection() as HttpURLConnection
        var complete = false
        fun checkCancelled() { if (cancelled() || Thread.currentThread().isInterrupted) throw java.util.concurrent.CancellationException("장면 받기를 취소했어요") }
        try {
            checkCancelled()
            c.connectTimeout = 5000
            c.readTimeout = 10000
            c.instanceFollowRedirects = false // 참가자 토큰이 다른 주소로 따라가지 않게 합니다.
            c.setRequestProperty("Authorization", "Bearer $token")
            connection(c)
            checkCancelled()
            if (c.responseCode !in 200..299) throw ApiError(c.responseCode, "장면 소리를 받지 못했어요")
            require(mimeType == null || c.contentType?.substringBefore(';') == mimeType) { "영상 형식을 확인하지 못했어요" }
            checkCancelled()
            c.inputStream.use { input -> checkCancelled(); openOutput().use { output ->
                val bytes = ByteArray(8192)
                var total = 0L
                while (true) {
                    checkCancelled()
                    val read = input.read(bytes)
                    checkCancelled()
                    if (read < 0) break
                    total += read
                    if (total > maxBytes) throw IllegalArgumentException("장면 파일이 너무 커요")
                    output.write(bytes, 0, read)
                }
            } }
            checkCancelled()
            complete = true
        } finally {
            connection(null)
            c.disconnect()
            if (!complete) file.delete()
        }
    }

    /** 부탁 남기기(T9). 새 부탁의 id. 처음 상태는 held. */
    fun request(code: String, by: String, text: String): String =
        JSONObject(call("POST", "/api/trips/$code/requests", JSONObject().put("by", by).put("text", text.take(200)).put("when", "now"))!!).getString("id")

    /** 부탁 상태 바꾸기. 갈 수 없는 길이면(그사이 폰에서 취소됨 등) 409 ApiError. */
    fun requestStatus(code: String, id: String, status: String) {
        call("PATCH", "/api/trips/$code/requests/$id", JSONObject().put("status", status))
    }

    /** 동승 연결(T46, #195): 탑승자 폰 QR의 code와 고른 자리로 참가시킨다. 새 참가자의 이름. 자리가 찼거나 이미 쓴 QR은 409, 만료·없는 QR은 404. 동의는 폰에서만 켠다. */
    fun rideLink(code: String, qr: String, seat: Seat): Person =
        JSONObject(call("POST", "/api/trips/$code/ride-links", JSONObject().put("code", qr).put("seat", seat.name))!!).getJSONObject("participant")
            .let { Person(it.getString("id"), it.getString("name"), it.getString("seat"), it.getBoolean("consent"), true) }

    /** 최신 여행. 보낸 version에서 바뀐 것이 없으면(304) null. 서버에서 여행이 삭제됐거나 없으면 Gone. */
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
        call("POST", "/api/trips/$code/recordings?moment=" + java.net.URLEncoder.encode(moment, "UTF-8") + "&generation=$generation&from=$from", wav, token)
    }

    /** 출발 전 목소리 등록(#65): 그 참가자 본인의 토큰으로, 녹음 동의가 켜져 있을 때만. wav는 16 kHz 모노 1~20초. */
    fun voice(code: String, id: String, token: String, wav: ByteArray) {
        call("POST", "/api/trips/$code/participants/$id/voice", wav, token)
    }

    /**
     * 발화 목소리 대조(#65). row는 1 앞줄·2 뒷줄, 모르면 null(모든 참가자가 후보). device·seq를 주면 서버가 그 발화 줄에 화자를 붙인다.
     * 찾은 참가자(확신이 기준보다 낮으면 null)와 확신도.
     */
    fun voiceMatch(code: String, token: String, row: Int?, device: String, seq: Long, wav: ByteArray): Speaker =
        JSONObject(call("POST", "/api/trips/$code/voice-match?" + (row?.let { "row=$it&" } ?: "") + "device=" + java.net.URLEncoder.encode(device, "UTF-8") + "&seq=$seq", wav, token)!!)
            .let { Speaker(if (it.isNull("participantId")) null else it.getString("participantId"), it.optDouble("confidence", 0.0)) }

    /** 사람이 고친 말한 사람을 서버 기록에도(#65, PATCH /utterances/:device/:seq). 그 기기로 올린 참가자의 토큰. null이면 모름. */
    fun fixSpeaker(code: String, token: String, device: String, seq: Long, participantId: String?) {
        call("PATCH", "/api/trips/$code/utterances/" + java.net.URLEncoder.encode(device, "UTF-8") + "/$seq",
            JSONObject().put("participantId", participantId ?: JSONObject.NULL), token)
    }

    /**
     * 지금 위치·진행 방향과 내비 목적지·남은 길로 고른 경로 위 휴게소(T97), 좋은 순. 위치는 본문으로만 보낸다.
     * 제안이 늦지 않게(요청 끝에서 제안까지 p95 5초 목표) 2초만 기다린다. 실패하면 부른 쪽이 고정 목록으로 간다.
     */
    fun restStops(lat: Double, lng: Double, heading: Double?, to: Place?, remain: Int?): List<Place> {
        val from = JSONObject().put("lat", lat).put("lng", lng)
        heading?.let { from.put("heading", (it % 360 + 360) % 360) }
        val body = JSONObject().put("from", from).put("limit", 3)
        to?.let { body.put("to", JSONObject().put("lat", it.lat).put("lng", it.lng)) }
        remain?.let { body.put("remainMeters", it) }
        return restStopsOf(call("POST", "/api/rest-stops", body, timeoutMs = 2000)!!)
    }

    private fun call(method: String, path: String, body: Any?, token: String? = null, timeoutMs: Int = 5000): String? {
        val c = URL(base + path).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method // 안드로이드의 HttpURLConnection은 PATCH를 받는다
            c.connectTimeout = timeoutMs
            c.readTimeout = timeoutMs
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

/** 서버가 여행을 모른다(404: 삭제되었거나 없음). 차 안 사본도 지운다(T69). */
class Gone(code: String) : ApiError(404, "없는 여행 $code")
