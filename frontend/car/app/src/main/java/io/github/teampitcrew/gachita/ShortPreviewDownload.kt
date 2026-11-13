package io.github.teampitcrew.gachita

import java.io.File
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.util.concurrent.CancellationException

/** 미리듣기와 영상 만들기는 현재 여행의 같은 출처 원음만 받습니다. */
fun shortClipAddress(server: String, code: String, clip: String): String {
    val base = URI(server.trim().trimEnd('/'))
    val address = if (clip.startsWith("/") && !clip.startsWith("//")) base.resolve(clip) else URI(clip)
    fun port(uri: URI) = if (uri.port >= 0) uri.port else if (uri.scheme.equals("https", true)) 443 else 80
    require(base.scheme in setOf("http", "https") && base.host != null && base.userInfo == null &&
        address.scheme.equals(base.scheme, true) && address.host.equals(base.host, true) && port(address) == port(base) &&
        address.userInfo == null && address.rawQuery == null && address.fragment == null &&
        Regex("/api/trips/${Regex.escape(code)}/recordings/[A-Za-z0-9-]+").matches(address.rawPath.orEmpty())) {
        "이 여행의 장면 소리가 아니에요"
    }
    return address.toASCIIString()
}

/**
 * 받는 요청이 파일을 소유하고, 완료 후 takeFile 한 번만 재생 쪽으로 넘깁니다.
 * disconnect는 일부 플랫폼에서 read를 기다리므로 호출자가 별도 정리 실행자로 보냅니다.
 */
class ShortPreviewDownload(private val file: File, private val disconnect: (HttpURLConnection) -> Unit) {
    private enum class State { DOWNLOADING, READY, DELIVERED, CANCELLED }
    private val lock = Any()
    private var state = State.DOWNLOADING
    private var connection: HttpURLConnection? = null
    @Volatile var isCancelled = false
        private set

    fun trackConnection(active: HttpURLConnection?) {
        val rejected = synchronized(lock) {
            if (isCancelled) active else { connection = active; null }
        }
        rejected?.let(disconnect)
    }

    /** 취소의 삭제와 파일 열기를 같은 잠금으로 묶어, 삭제 뒤 파일이 다시 생기지 않게 합니다. */
    fun openOutput(): OutputStream = synchronized(lock) {
        if (state != State.DOWNLOADING) throw CancellationException()
        file.outputStream()
    }

    fun ready() = synchronized(lock) {
        if (state == State.DOWNLOADING) state = State.READY
    }

    fun takeFile(): File? = synchronized(lock) {
        if (state != State.READY) null else { state = State.DELIVERED; file }
    }

    fun cancel() {
        val active = synchronized(lock) {
            if (state == State.DELIVERED || state == State.CANCELLED) return
            state = State.CANCELLED
            isCancelled = true
            file.delete()
            connection.also { connection = null }
        }
        active?.let(disconnect)
    }
}
