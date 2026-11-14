package io.github.teampitcrew.gachita

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean

/** 가치타 API(docs/api/openapi.yaml)를 부른다. 메인 스레드에서 부르지 않는다. */
class Server(base: String, private val open: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection }) {
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

    /**
     * 본인 동의 켜기와 그 뒤 여행 조회. PATCH는 한 번만 보낸다: 서버는 값을 대입하므로 다시 보내면 그사이 다른 기기의 철회를
     * 되살린다(Astra #352). PATCH가 502여도(서버에 닿았는지 모름) 다시 보내지 않고 사용자가 다시 누르게 한다. 뒤의 조회만 다시 묻는다(T122).
     */
    fun agree(code: String, id: String, token: String): Got {
        consent(code, id, true, token)
        return retryTransient { trip(code)!! }
    }

    fun seat(code: String, id: String, seat: Seat) {
        call("PATCH", "/api/trips/$code/participants/$id", JSONObject().put("seat", seat.name))
    }

    /** 발화 묶음 올리기(ADR-0014). 서버가 빠짐없이 받은 마지막 순번. 동의하지 않은 사람이 있으면 403 ApiError. */
    fun utterances(code: String, token: String, device: String, items: JSONArray): Long =
        JSONObject(call("POST", "/api/trips/$code/utterances", JSONObject().put("device", device).put("items", items), token)!!).getLong("lastSeq")

    /** 숏폼 구성(T43, #63 계약). 녹음에 동의한 참가자의 토큰으로. */
    fun transcript(code: String, token: String): String = call("GET", "/api/trips/$code/transcript", null, token)!!

    fun todos(code: String, token: String): SharedTodos = sharedTodos(call("GET", "/api/trips/$code/todos", null, token)!!)

    fun todoStatus(code: String, token: String, id: String, generation: Int, expectedVersion: Int, status: String): Pair<Int, SharedTodo> {
        require(status in setOf("pending", "done", "cancelled"))
        val path = "/api/trips/$code/todos/" + java.net.URLEncoder.encode(id, "UTF-8")
        return JSONObject(call("PATCH", path, JSONObject().put("generation", generation).put("expectedVersion", expectedVersion).put("status", status), token)!!)
            .let { it.getInt("generation") to sharedTodo(it.getJSONObject("item")) }
    }

    /** 차가 P에서 D로 나가면 여행을 주행으로 바꾼다. 서버는 모두 동의했을 때만 기록 표시(recording)를 켠다. */
    fun departed(code: String, token: String): Got = got(call("PATCH", "/api/trips/$code", JSONObject().put("status", "driving"), token)!!)

    /** 실제 차량 P 관측으로 호출하며, 서버가 확인한 주차 상태 뒤에 도착 판정을 요청합니다. */
    fun parkedForArrival(code: String, token: String): Got = got(call("PATCH", "/api/trips/$code", JSONObject().put("status", "parked"), token)!!)
    fun arrivalBriefing(code: String, token: String, generation: Int, observation: VehicleArrival): SharedArrival =
        sharedArrival(call("POST", "/api/trips/$code/arrival-briefing", observation.body(generation, parked = true), token)!!)

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

    /** 차량 운전석 참가자가 5분 초대를 발급합니다. 프로필·참가자 토큰은 QR에 포함하지 않습니다. */
    internal fun boardingInvite(code: String, token: String): BoardingInvite =
        JSONObject(call("POST", "/api/trips/$code/boarding-invites", JSONObject(), token)!!).let {
            BoardingInvite(it.getString("id"), boardingInviteUrl(base, it.getString("url")), it.getLong("expiresAt"))
        }

    internal fun revokeBoardingInvite(code: String, token: String, id: String) {
        call("DELETE", "/api/trips/$code/boarding-invites/" + java.net.URLEncoder.encode(id, "UTF-8"), null, token)
    }

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

    /** 출발 전 목소리 등록(ADR-0023): 그 참가자 본인의 토큰으로, 녹음 동의가 켜져 있을 때만. 차 안에서 계산한 값만 보낸다(소리는 보내지 않음). */
    fun voice(code: String, id: String, token: String, vector: DoubleArray, seconds: Double) {
        call("POST", "/api/trips/$code/participants/$id/voice", voiceValue(vector, seconds), token)
    }

    /** 녹음에 동의한 탑승자의 목소리 대조 값과 기준(GET /voice-prints). 차 안 대조에 쓴다. 옛 서버면 404 ApiError. */
    fun voicePrints(code: String, token: String): JSONObject = JSONObject(call("GET", "/api/trips/$code/voice-prints", null, token)!!)

    /** 사람이 고친 말한 사람을 서버 기록에도(#65, PATCH /utterances/:device/:seq). 그 기기로 올린 참가자의 토큰. null이면 모름. */
    fun fixSpeaker(code: String, token: String, device: String, seq: Long, participantId: String?) {
        call("PATCH", "/api/trips/$code/utterances/" + java.net.URLEncoder.encode(device, "UTF-8") + "/$seq",
            JSONObject().put("participantId", participantId ?: JSONObject.NULL), token)
    }

    /**
     * 지금 위치·진행 방향과 내비 목적지·남은 길로 고른 경로 위 휴게소(T97), 좋은 순. 위치는 본문으로만 보낸다.
     * 제안이 늦지 않게(요청 끝에서 제안까지 p95 5초 목표) 연결부터 본문 끝까지 모두 2초만 기다린다(deadlineMs). 넘으면 연결을 끊어
     * 공용 실행기(io)를 풀고 던진다. 실패하면 부른 쪽이 고정 목록으로 간다.
     */
    fun restStops(lat: Double, lng: Double, heading: Double?, to: Place?, remain: Int?): List<Place> {
        val from = JSONObject().put("lat", lat).put("lng", lng)
        heading?.let { from.put("heading", (it % 360 + 360) % 360) }
        val body = JSONObject().put("from", from).put("limit", 3)
        to?.let { body.put("to", JSONObject().put("lat", it.lat).put("lng", it.lng)) }
        remain?.let { body.put("remainMeters", it) }
        return restStopsOf(call("POST", "/api/rest-stops", body, timeoutMs = 2000, deadlineMs = 2000)!!)
    }

    /**
     * deadlineMs를 주면 호출 전체(연결·보내기·받기)의 마감이다. connect·readTimeout은 단계마다 따로 걸리고, 본문이 조금씩 오면
     * readTimeout이 매번 다시 시작해 끝없이 기다릴 수 있다. 마감에 연결을 끊으면 막힌 읽기가 바로 예외로 풀린다.
     */
    private fun call(method: String, path: String, body: Any?, token: String? = null, timeoutMs: Int = 5000, deadlineMs: Int? = null): String? {
        val c = open(URL(base + path))
        val expire = deadlineMs?.let { DEADLINES.schedule({ c.disconnect() }, it.toLong(), TimeUnit.MILLISECONDS) }
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
            if (expire?.isDone == true) throw SocketTimeoutException("${deadlineMs}ms 마감") // 끊긴 연결에서 잘린 본문을 쓰지 않는다
            return text
        } catch (e: java.io.IOException) {
            throw if (expire?.isDone == true) SocketTimeoutException("${deadlineMs}ms 마감") else e
        } finally {
            expire?.cancel(false)
            c.disconnect()
        }
    }
}

/** 서버가 거절함(4xx·5xx). 통신 자체가 안 된 것(IOException)과 구분해 '연결 끊김'으로 보지 않는다. */
open class ApiError(val status: Int, message: String) : Exception("$status $message") {
    /** 502·503·504: 배포 중이거나 앞단(ALB·Cloudflare)이 잠깐 못 받았다. 거절이 아니고, 본문도 앞단의 것이다(T122). */
    val transient: Boolean get() = status in 502..504
}

/** 화면에 보일 실패 이유. 잠깐 못 받은 응답은 거절과 나누고 앞단 본문('error code: 502')을 붙이지 않는다(T122). */
fun failureText(e: Throwable): String = when {
    e is ApiError && e.transient -> "서버가 잠깐 응답하지 않아요"
    e is ApiError -> "서버가 거절했어요(${e.message})"
    else -> "서버에 닿지 않아요"
}

/**
 * 502·503·504면 waits만큼 쉬고 다시 보낸다(T122). 다시 보내도 결과가 같은 요청(조회, 같은 값 저장)에만 쓴다.
 * 쉬는 동안 그 실행기를 붙잡으니 메인 스레드에서 부르지 않는다. 거절(4xx 등)과 통신 실패는 바로 던진다.
 */
fun <T> retryTransient(waits: List<Long> = listOf(500, 1000), sleep: (Long) -> Unit = Thread::sleep, work: () -> T): T {
    for (w in waits) {
        try { return work() } catch (e: ApiError) { if (!e.transient) throw e }
        sleep(w)
    }
    return work()
}

/** 서버(withTrip)가 여행을 모를 때의 404 문구. 이것만 여행이 없어진 것으로 본다. */
/** 호출 마감(deadlineMs)에 연결을 끊는 타이머. 데몬 스레드 하나를 모든 Server가 함께 쓴다. */
private val DEADLINES = Executors.newSingleThreadScheduledExecutor { Thread(it, "gachita-deadline").apply { isDaemon = true } }

/**
 * work를 exec에서 돌리되 deadlineMs가 지나면 그 일이 끝났든 아니든 실패(TimeoutException)로 한 번만 확정한다. 늦게 온 답은 버린다.
 * 휴게소 추천용(Astra #317 3차): DNS 조회는 끊을 수 없어 연결을 끊는 마감(deadlineMs)만으로는 부른 쪽이 계속 기다린다.
 * done은 exec나 마감 스레드에서 한 번 불린다. exec가 막혀 있어도(앞의 늦은 DNS) 마감은 제때 온다.
 */
fun <T> within(exec: ExecutorService, deadlineMs: Long, work: () -> T, done: (Result<T>) -> Unit) {
    if (exec.isShutdown) return
    val settled = AtomicBoolean()
    fun settle(r: Result<T>) { if (settled.compareAndSet(false, true)) done(r) }
    val expire = DEADLINES.schedule({ settle(Result.failure(TimeoutException("${deadlineMs}ms 안에 답이 없음"))) }, deadlineMs, TimeUnit.MILLISECONDS)
    exec.execute { val r = runCatching(work); expire.cancel(false); settle(r) }
}

private val TRIP_GONE = setOf("없는 여행 코드", "보관 기간이 지난 여행")

/** 서버가 여행을 모른다(404: 삭제되었거나 없음). 차 안 사본도 지운다(T69). */
class Gone(code: String) : ApiError(404, "없는 여행 $code")
