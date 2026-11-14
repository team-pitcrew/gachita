package io.github.teampitcrew.gachita

import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicReference

internal const val SHARED_SHORT_MAX_BYTES = 64_000_000L
internal data class SharedShortSource(val moment: String, val generation: Int, val hash: String, val seconds: Double, val short: Short)
internal fun parseSharedShortSource(value: JSONObject): SharedShortSource {
    val moment = value.getString("momentId")
    require(moment.matches(Regex("[A-Za-z0-9_-]{1,40}")))
    val generation = value.getInt("generation")
    val hash = value.getString("sourceHash")
    val seconds = value.getDouble("seconds")
    val short = parseShort(value.getJSONObject("source").toString())
    require(generation > 0 && hash.matches(Regex("[0-9a-f]{64}")) && seconds in .5..60.0)
    require(short.generation == generation && short.scenes.size == 1 && short.scenes.single().momentId == moment && kotlin.math.abs(short.scenes.single().seconds - seconds) < .001) { "원본 장면을 확인하지 못했어요" }
    return SharedShortSource(moment, generation, hash, seconds, short)
}
internal fun sharedShortSame(a: SharedShortSource, b: SharedShortSource) = a.moment == b.moment && a.generation == b.generation && a.hash == b.hash
internal fun sharedShortOrigin(item: JSONObject) = item.optString("origin", "provider")
internal fun sharedShortKey(item: JSONObject) = "${sharedShortOrigin(item)}:${item.getString("id")}"
internal fun sharedShortMime(item: JSONObject) = item.optJSONObject("result")?.optString("mimeType", "video/mp4") ?: "video/mp4"
internal fun sharedShortFile(base: String, code: String, item: JSONObject): String {
    if (sharedShortOrigin(item) == "provider") return generationFile(base, code, item)
    require(sharedShortOrigin(item) == "local-render")
    val id = item.getString("id")
    require(id.matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) && code.matches(Regex("[A-Z0-9]+")))
    val path = "/api/trips/$code/short-assets/$id/file"
    require(item.getString("state") == "completed" && item.getJSONObject("result").getString("url") == path)
    val uri = URI(base.trimEnd('/'))
    require(uri.scheme in listOf("http", "https") && uri.host != null && uri.rawQuery == null && uri.rawUserInfo == null && uri.rawFragment == null && uri.path.orEmpty() in listOf("", "/"))
    require(sharedShortMime(item) in listOf("video/mp4", "video/webm"))
    return base.trimEnd('/') + path
}
internal fun shortFileHash(file: File): String = file.inputStream().use { input ->
    val hash = MessageDigest.getInstance("SHA-256"); val buffer = ByteArray(128 * 1024)
    while (true) { val n = input.read(buffer); if (n < 0) break; hash.update(buffer, 0, n) }
    hash.digest().joinToString("") { "%02x".format(it) }
}

/** One UI owner cancels its own socket. Tokens never enter file URLs or persistent metadata. */
internal class SharedShortApi(private val base: String) {
    private val connection = AtomicReference<HttpURLConnection?>(null)
    @Volatile private var cancelled = false
    fun cancel() { cancelled = true; connection.getAndSet(null)?.disconnect() }
    private fun check() { if (cancelled || Thread.currentThread().isInterrupted) throw CancellationException("영상 전송을 취소했어요") }
    private fun query(v: String) = URLEncoder.encode(v, "UTF-8")
    private fun path(code: String): String { require(code.matches(Regex("[A-Z0-9]+"))); return "/api/trips/$code/short-assets" }
    fun source(code: String, token: String, moment: String) = parseSharedShortSource(request("GET", path(code) + "/source?moment=" + query(moment), token)!!)
    fun list(code: String, token: String, generation: Int? = null) = request("GET", path(code), token)!!.also {
        if (generation != null && it.getInt("generation") != generation) throw ApiError(409, "기록 동의가 바뀌었어요. 여행 상태를 다시 확인해 주세요")
    }.getJSONArray("items")
    fun item(code: String, token: String, item: JSONObject): JSONObject {
        if (sharedShortOrigin(item) == "provider") return Server(base).completedShortJob(code, token, item.getString("id"))
        return request("GET", path(code) + "/" + query(item.getString("id")), token)!!.also { require(it.optString("state") == "completed") { "영상이 아직 보관되지 않았어요" } }
    }
    fun delete(code: String, token: String, id: String) { request("DELETE", path(code) + "/" + query(id), token) }
    fun upload(code: String, token: String, source: SharedShortSource, file: File, key: String, expectedHash: String, progress: (Float) -> Unit): JSONObject {
        require(key.matches(Regex("[A-Za-z0-9_-]{8,100}")))
        require(file.length() in 12..SHARED_SHORT_MAX_BYTES && shortFileHash(file) == expectedHash) { "보관할 영상 파일이 바뀌었어요" }
        val url = path(code) + "?moment=${query(source.moment)}&generation=${source.generation}&sourceHash=${source.hash}&key=${query(key)}"
        val item = request("POST", url, token, file, progress)!!
        require(item.optString("state") == "completed" && item.optString("origin") == "local-render" && item.optString("momentId") == source.moment && item.optInt("generation") == source.generation && item.optString("sourceHash") == source.hash && item.getJSONObject("result").getString("sha256") == expectedHash) { "서버에 보관한 파일을 확인하지 못했어요" }
        return item
    }
    private fun request(method: String, path: String, token: String, file: File? = null, progress: (Float) -> Unit = {}): JSONObject? {
        check()
        val c = URL(base.trimEnd('/') + path).openConnection() as HttpURLConnection
        try {
            connection.set(c); check(); c.requestMethod = method; c.instanceFollowRedirects = false
            c.connectTimeout = 5000; c.readTimeout = if (file == null) 15000 else 150000
            c.setRequestProperty("Authorization", "Bearer $token")
            if (file != null) {
                c.doOutput = true; c.setFixedLengthStreamingMode(file.length()); c.setRequestProperty("Content-Type", "video/mp4")
                file.inputStream().use { input -> c.outputStream.use { output ->
                    val buffer = ByteArray(128 * 1024); var sent = 0L
                    while (true) { check(); val n = input.read(buffer); if (n < 0) break; output.write(buffer, 0, n); sent += n; progress(sent.toFloat() / file.length()) }
                } }
            }
            check(); val status = c.responseCode
            val text = (if (status in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
            check()
            if (status !in 200..299) throw ApiError(status, runCatching { JSONObject(text).getString("error") }.getOrDefault("서버 보관함에 연결하지 못했어요"))
            return text.takeIf { it.isNotBlank() }?.let(::JSONObject)
        } finally { connection.compareAndSet(c, null); c.disconnect() }
    }
}
